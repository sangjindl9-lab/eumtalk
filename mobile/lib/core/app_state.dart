import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';
import 'realtime.dart';

/// 로그인 상태, 대화 목록, 인사 요청, 전송 대기열을 한곳에서 관리한다.
class AppState extends ChangeNotifier with WidgetsBindingObserver {
  AppState(this.prefs) {
    api = ApiClient(
      prefs.getString(_kBaseUrl) ?? defaultBaseUrl,
      token: prefs.getString(_kToken),
      onUnauthorized: _onUnauthorized,
    );
  }

  static const defaultBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );
  static const allowServerOverride = bool.fromEnvironment(
    'ALLOW_SERVER_OVERRIDE',
    defaultValue: true,
  );
  static const _kBaseUrl = 'baseUrl';
  static const _kToken = 'token';
  static const _kMe = 'me';
  static const _kOutbox = 'outbox';

  final SharedPreferences prefs;
  late final ApiClient api;

  bool booting = true;
  Me? me;
  bool connected = false;
  bool inboxLoaded = false;
  String? inboxError;
  List<Conversation> conversations = [];
  List<Greeting> received = [];
  List<Region> regions = [];
  List<Interest> interests = [];
  List<String> ageBands = const ['20대', '30대', '40대', '50대', '60대 이상'];
  final List<PendingMessage> outbox = [];
  String? openConversationId;

  final Map<String, ChatController> _chats = {};
  final Set<String> _inFlight = {};
  Realtime? _rt;
  bool _flushing = false;

  bool get signedIn => api.token != null && me != null;
  int get unreadTotal => conversations.fold(0, (sum, c) => sum + c.unreadCount);
  int get pendingGreetings => received.length;
  String get baseUrl => api.baseUrl;

  Future<void> boot() async {
    WidgetsBinding.instance.addObserver(this);
    for (final raw in prefs.getStringList(_kOutbox) ?? const <String>[]) {
      try {
        outbox.add(
          PendingMessage.fromJson(jsonDecode(raw) as Map<String, dynamic>),
        );
      } catch (_) {
        // 손상된 항목은 버린다.
      }
    }
    if (api.token != null) {
      final cached = prefs.getString(_kMe);
      if (cached != null) {
        try {
          me = Me.fromJson(jsonDecode(cached) as Map<String, dynamic>);
        } catch (_) {
          me = null;
        }
      }
      try {
        await refreshMe();
      } on ApiException {
        // 401이면 _onUnauthorized 가 이미 로그아웃 처리했다.
      } on NetworkException {
        // 오프라인이면 저장해 둔 정보로 시작한다.
      }
      if (signedIn) _startSession();
    }
    booting = false;
    notifyListeners();
  }

  Future<void> setBaseUrl(String url) async {
    api.baseUrl = url.trim();
    await prefs.setString(_kBaseUrl, api.baseUrl);
    notifyListeners();
  }

  Future<void> loadCatalog() async {
    if (regions.isNotEmpty && interests.isNotEmpty) return;
    final r = await api.get('/v1/regions');
    final i = await api.get('/v1/interests');
    regions = (r['items'] as List)
        .map((e) => Region.fromJson(e as Map<String, dynamic>))
        .toList();
    interests = (i['items'] as List)
        .map((e) => Interest.fromJson(e as Map<String, dynamic>))
        .toList();
    final bands = i['ageBands'];
    if (bands is List) ageBands = bands.map((e) => e.toString()).toList();
    notifyListeners();
  }

  Future<void> refreshMe() async {
    final json = await api.get('/v1/me');
    me = Me.fromJson(json);
    await prefs.setString(_kMe, jsonEncode(json));
    notifyListeners();
  }

  Future<void> updateMe(Map<String, dynamic> patch) async {
    final json = await api.patch('/v1/me', patch);
    me = Me.fromJson(json);
    await prefs.setString(_kMe, jsonEncode(json));
    notifyListeners();
  }

  Future<void> completeLogin(String token) async {
    api.token = token;
    await prefs.setString(_kToken, token);
    await refreshMe();
    _startSession();
    notifyListeners();
  }

  void _startSession() {
    _rt?.dispose();
    _rt = Realtime(
      uri: () => api.wsUri,
      token: api.token!,
      onEvent: _onEvent,
      onState: _onRealtimeState,
    )..start();
    refreshInbox();
  }

  Future<void> logout({bool remote = true}) async {
    if (remote) {
      try {
        await api.post('/v1/auth/logout');
      } catch (_) {
        // 서버에 닿지 않아도 기기에서는 로그아웃한다.
      }
    }
    _clearLocal();
  }

  void _onUnauthorized() => _clearLocal();

  void _clearLocal() {
    _rt?.dispose();
    _rt = null;
    api.token = null;
    me = null;
    connected = false;
    inboxLoaded = false;
    conversations = [];
    received = [];
    outbox.clear();
    _chats.clear();
    prefs.remove(_kToken);
    prefs.remove(_kMe);
    prefs.remove(_kOutbox);
    for (final k
        in prefs.getKeys().where((k) => k.startsWith('draft:')).toList()) {
      prefs.remove(k);
    }
    notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && signedIn) {
      _rt?.kick();
      refreshInbox();
    }
  }

  void _onRealtimeState(bool ready) {
    connected = ready;
    notifyListeners();
    if (ready) {
      // 끊겨 있던 동안 놓친 것들을 채운다.
      refreshInbox();
      for (final chat in _chats.values) {
        if (chat.loaded) chat.sync();
      }
      flushOutbox();
    }
  }

  Future<void> refreshInbox() async {
    if (api.token == null) return;
    try {
      final c = await api.get('/v1/conversations');
      final g = await api.get('/v1/greetings');
      conversations = (c['items'] as List)
          .map((e) => Conversation.fromJson(e as Map<String, dynamic>))
          .toList();
      received = (g['items'] as List)
          .map((e) => Greeting.fromJson(e as Map<String, dynamic>))
          .toList();
      if (openConversationId != null) {
        for (final conv in conversations) {
          if (conv.id == openConversationId) conv.unreadCount = 0;
        }
      }
      inboxLoaded = true;
      inboxError = null;
    } on NetworkException catch (e) {
      inboxError = e.toString();
    } on ApiException catch (e) {
      inboxError = e.message;
    }
    notifyListeners();
  }

  Conversation? conversationById(String id) {
    for (final c in conversations) {
      if (c.id == id) return c;
    }
    return null;
  }

  ChatController chat(String conversationId) => _chats.putIfAbsent(
    conversationId,
    () => ChatController(this, conversationId),
  );

  void _onEvent(String type, Map<String, dynamic> data) {
    switch (type) {
      case 'greeting.received':
        final g = Greeting.fromJson(data['greeting'] as Map<String, dynamic>);
        if (!received.any((x) => x.id == g.id)) received.insert(0, g);
        notifyListeners();
        break;
      case 'greeting.updated':
        received.removeWhere((x) => x.id == data['greetingId']);
        notifyListeners();
        break;
      case 'conversation.created':
        final conv = Conversation.fromJson(
          data['conversation'] as Map<String, dynamic>,
        );
        conversations.removeWhere((c) => c.id == conv.id);
        conversations.insert(0, conv);
        notifyListeners();
        break;
      case 'message.new':
        _onMessage(Message.fromJson(data['message'] as Map<String, dynamic>));
        break;
      case 'conversation.read':
        final conv = conversationById(data['conversationId'] as String);
        if (conv != null) {
          final seq = (data['seq'] as num).toInt();
          if (data['userId'] == me?.userId) {
            conv.lastReadSeq = max(conv.lastReadSeq, seq);
            if (seq >= conv.lastSeq) conv.unreadCount = 0;
          } else {
            conv.peerReadSeq = max(conv.peerReadSeq, seq);
          }
          _chats[conv.id]?.touch();
          notifyListeners();
        }
        break;
      case 'block.updated':
        refreshInbox();
        break;
      case 'session.revoked':
        _clearLocal();
        break;
    }
  }

  void _onMessage(Message m) {
    final chat = _chats[m.conversationId];
    final isNew = chat == null || !chat.loaded || chat.addServerMessage(m);
    final conv = conversationById(m.conversationId);
    if (conv == null) {
      refreshInbox();
      return;
    }
    if (m.seq > conv.lastSeq) {
      conv.lastSeq = m.seq;
      conv.lastBody = m.body;
      conv.lastSenderId = m.senderId;
      conv.updatedAt = m.createdAt;
      if (m.senderId != me?.userId && isNew) {
        if (openConversationId == conv.id) {
          chat?.markRead();
        } else {
          conv.unreadCount += 1;
        }
      }
      conversations.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    }
    notifyListeners();
  }

  // ───────────── 전송 대기열 ─────────────

  static final Random _random = Random.secure();
  static String newClientMsgId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final tail = List.generate(
      14,
      (_) => chars[_random.nextInt(chars.length)],
    ).join();
    return 'm${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}$tail';
  }

  void _saveOutbox() {
    prefs.setStringList(
      _kOutbox,
      outbox.map((p) => jsonEncode(p.toJson())).toList(),
    );
  }

  /// 작성한 메시지를 먼저 기기에 저장한 뒤 전송한다. 통신이 끊겨도 사라지지 않는다.
  void enqueue(String conversationId, String text) {
    final p = PendingMessage(
      conversationId: conversationId,
      clientMsgId: newClientMsgId(),
      text: text,
      createdAt: DateTime.now(),
    );
    outbox.add(p);
    _saveOutbox();
    _chats[conversationId]?.touch();
    notifyListeners();
    flushOutbox();
  }

  void retry(PendingMessage p) {
    p.state = PendingState.queued;
    p.error = null;
    _saveOutbox();
    _chats[p.conversationId]?.touch();
    flushOutbox();
  }

  void discard(PendingMessage p) {
    outbox.remove(p);
    _saveOutbox();
    _chats[p.conversationId]?.touch();
    notifyListeners();
  }

  /// 대기 중인 메시지를 작성 순서대로 하나씩 보낸다. 같은 clientMsgId 로 다시 보내도 서버가 중복을 걸러낸다.
  Future<void> flushOutbox() async {
    if (_flushing || api.token == null) return;
    _flushing = true;
    try {
      while (true) {
        PendingMessage? next;
        for (final p in outbox) {
          if (p.state == PendingState.queued &&
              !_inFlight.contains(p.clientMsgId)) {
            next = p;
            break;
          }
        }
        if (next == null) break;
        final ok = await _deliver(next);
        if (!ok) break; // 네트워크가 없으면 멈추고 재연결 때 다시 시도한다.
      }
    } finally {
      _flushing = false;
    }
  }

  Future<bool> _deliver(PendingMessage p) async {
    _inFlight.add(p.clientMsgId);
    p.state = PendingState.sending;
    _chats[p.conversationId]?.touch();
    try {
      final res = await api.post(
        '/v1/conversations/${p.conversationId}/messages',
        {'clientMsgId': p.clientMsgId, 'text': p.text},
      );
      final m = Message.fromJson(res['message'] as Map<String, dynamic>);
      outbox.remove(p);
      _saveOutbox();
      _onMessage(m);
      chat(p.conversationId).addServerMessage(m);
      return true;
    } on NetworkException {
      p.state = PendingState.queued;
      _chats[p.conversationId]?.touch();
      return false;
    } on ApiException catch (e) {
      p.state = PendingState.failed;
      p.error = e.message;
      _saveOutbox();
      _chats[p.conversationId]?.touch();
      notifyListeners();
      return true;
    } finally {
      _inFlight.remove(p.clientMsgId);
    }
  }

  void notifyInbox() => notifyListeners();

  String draftFor(String conversationId) =>
      prefs.getString('draft:$conversationId') ?? '';
  void saveDraft(String conversationId, String text) {
    if (text.isEmpty) {
      prefs.remove('draft:$conversationId');
    } else {
      prefs.setString('draft:$conversationId', text);
    }
  }
}

/// 대화방 하나의 메시지 목록. seq 기준으로 정렬하고 id 로 중복을 걸러낸다.
class ChatController extends ChangeNotifier {
  ChatController(this.app, this.conversationId);

  final AppState app;
  final String conversationId;
  final List<Message> messages = [];
  final Set<String> _ids = {};
  bool loading = false;
  bool loaded = false;
  bool hasOlder = true;
  bool loadingOlder = false;
  String? error;
  bool _syncing = false;

  int get lastSeq => messages.isEmpty ? 0 : messages.last.seq;
  List<PendingMessage> get pending =>
      app.outbox.where((p) => p.conversationId == conversationId).toList();

  void touch() => notifyListeners();

  /// 새 메시지면 true. 이미 가진 메시지면 아무것도 하지 않는다.
  bool addServerMessage(Message m) {
    if (_ids.contains(m.id)) return false;
    _ids.add(m.id);
    var i = messages.length;
    while (i > 0 && messages[i - 1].seq > m.seq) {
      i--;
    }
    messages.insert(i, m);
    notifyListeners();
    return true;
  }

  Future<void> load() async {
    if (loading) return;
    if (loaded) return sync();
    loading = true;
    error = null;
    notifyListeners();
    try {
      final res = await app.api.get(
        '/v1/conversations/$conversationId/messages',
        query: {'limit': '50'},
      );
      final items = (res['items'] as List)
          .map((e) => Message.fromJson(e as Map<String, dynamic>))
          .toList();
      for (final m in items) {
        addServerMessage(m);
      }
      hasOlder = items.length >= 50;
      loaded = true;
    } on NetworkException catch (e) {
      error = e.toString();
    } on ApiException catch (e) {
      error = e.message;
    }
    loading = false;
    notifyListeners();
  }

  /// 마지막으로 받은 seq 이후의 메시지를 모두 받아온다(재연결 직후 호출).
  Future<void> sync() async {
    if (_syncing || !loaded) return;
    _syncing = true;
    try {
      while (true) {
        final res = await app.api.get(
          '/v1/conversations/$conversationId/messages',
          query: {'afterSeq': '$lastSeq', 'limit': '200'},
        );
        final items = (res['items'] as List)
            .map((e) => Message.fromJson(e as Map<String, dynamic>))
            .toList();
        for (final m in items) {
          addServerMessage(m);
        }
        if (res['hasMore'] != true || items.isEmpty) break;
      }
      if (app.openConversationId == conversationId) markRead();
    } catch (_) {
      // 다음 재연결 때 다시 시도한다.
    } finally {
      _syncing = false;
    }
  }

  Future<void> loadOlder() async {
    if (loadingOlder || !hasOlder || messages.isEmpty) return;
    loadingOlder = true;
    notifyListeners();
    try {
      final res = await app.api.get(
        '/v1/conversations/$conversationId/messages',
        query: {'beforeSeq': '${messages.first.seq}', 'limit': '50'},
      );
      final items = (res['items'] as List)
          .map((e) => Message.fromJson(e as Map<String, dynamic>))
          .toList();
      for (final m in items) {
        addServerMessage(m);
      }
      hasOlder = items.length >= 50;
    } catch (_) {
      // 스크롤을 다시 올리면 재시도된다.
    }
    loadingOlder = false;
    notifyListeners();
  }

  Future<void> markRead() async {
    final conv = app.conversationById(conversationId);
    if (lastSeq == 0) return;
    if (conv != null) {
      if (conv.unreadCount == 0 && conv.lastReadSeq >= lastSeq) return;
      conv.unreadCount = 0;
      conv.lastReadSeq = lastSeq;
      app.notifyInbox();
    }
    try {
      await app.api.post('/v1/conversations/$conversationId/read', {
        'seq': lastSeq,
      });
    } catch (_) {
      // 읽음 위치는 다음 기회에 다시 보낸다.
    }
  }
}
