import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:share_plus/share_plus.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/models.dart';
import 'media.dart';
import 'monetize.dart' show showGiftDialog;
import 'profile_page.dart';
import 'rooms.dart';
import 'widgets.dart';

/// 1대1·그룹 대화 화면. 메시지와 입력창에만 집중하도록 구성한다.
class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.conversationId, required this.title});
  final String conversationId;
  final String title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  late AppState _app;
  late ChatController _chat;
  late final TextEditingController _input;
  bool _ready = false;
  bool _sendingPhoto = false;
  Message? _replyTo;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ready) return;
    _ready = true;
    _app = AppScope.read(context);
    _chat = _app.chat(widget.conversationId);
    _input = TextEditingController(text: _app.draftFor(widget.conversationId));
    _app.openConversationId = widget.conversationId;
    _chat.load().then((_) => _chat.markRead());
  }

  @override
  void dispose() {
    if (_app.openConversationId == widget.conversationId) _app.openConversationId = null;
    _app.saveDraft(widget.conversationId, _input.text);
    _input.dispose();
    super.dispose();
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    _app.enqueue(widget.conversationId, text, replyToId: _replyTo?.id);
    _input.clear();
    _app.saveDraft(widget.conversationId, '');
    setState(() => _replyTo = null);
  }

  Future<void> _sendPhoto() async {
    final Uint8List? bytes = await pickPhoto(context);
    if (bytes == null || !mounted) return;
    setState(() => _sendingPhoto = true);
    try {
      await _app.sendImage(widget.conversationId, bytes);
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException {
      if (mounted) showMessage(context, '사진을 보내지 못했어요. 연결을 확인한 뒤 다시 보내 주세요.');
    } finally {
      if (mounted) setState(() => _sendingPhoto = false);
    }
  }

  Future<void> _block(Conversation conv) async {
    final ok = await confirm(context, title: '${conv.title} 님을 차단할까요?', message: '차단하면 새 인사와 메시지·알림이 오지 않고, 서로 주변 목록에 보이지 않습니다.', action: '차단');
    if (!ok) return;
    try {
      await _app.api.post('/v1/blocks', {'userId': conv.peerId});
      await _app.refreshInbox();
      if (mounted) showMessage(context, '차단했습니다.');
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  Future<void> _toggleMute(Conversation conv) async {
    try {
      await _app.api.post('/v1/conversations/${conv.id}/mute', {'muted': !conv.muted});
      conv.muted = !conv.muted;
      _app.notifyInbox();
      if (mounted) showMessage(context, conv.muted ? '이 대화의 알림을 껐습니다.' : '이 대화의 알림을 켰습니다.');
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  Future<void> _leave(Conversation conv) async {
    final ok = await confirm(context, title: '대화방에서 나갈까요?', message: '내 목록에서 사라집니다. 상대가 다시 메시지를 보내면 목록에 다시 나타납니다.', action: '나가기');
    if (!ok) return;
    try {
      await _app.api.post('/v1/conversations/${conv.id}/leave');
      await _app.refreshInbox();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  Future<void> _export() async {
    try {
      final res = await _app.api.get('/v1/conversations/${widget.conversationId}/export');
      final name = (res['filename'] ?? '대화.txt') as String;
      final bytes = Uint8List.fromList(utf8.encode(res['text'] as String));
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile.fromData(bytes, mimeType: 'text/plain', name: name)],
          fileNameOverrides: [name],
        ),
      );
    } catch (e) {
      if (mounted) showMessage(context, e is ApiException ? e.message : '내보내지 못했어요. 다시 시도해 주세요.');
    }
  }

  void _search() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (_) => _SearchSheet(conversationId: widget.conversationId),
    );
  }

  void _messageMenu(Message m, bool mine, Conversation? conv) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.reply_outlined),
              title: const Text('답장'),
              onTap: () {
                Navigator.of(sheet).pop();
                setState(() => _replyTo = m);
              },
            ),
            if (!m.isImage)
              ListTile(
                leading: const Icon(Icons.copy_outlined),
                title: const Text('복사'),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: m.body));
                  Navigator.of(sheet).pop();
                  showMessage(context, '복사했습니다.');
                },
              ),
            if (conv != null && conv.isGroup && conv.isStaff && !m.isImage)
              ListTile(
                leading: const Icon(Icons.push_pin_outlined),
                title: const Text('공지로 고정'),
                onTap: () async {
                  Navigator.of(sheet).pop();
                  try {
                    await _app.api.post('/v1/rooms/${conv.id}/notice', {'messageId': m.id});
                    if (mounted) showMessage(context, '공지로 고정했습니다.');
                  } catch (e) {
                    if (mounted) showMessage(context, e.toString());
                  }
                },
              ),
            if (!mine)
              ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: Text(m.isImage ? '이 사진 신고' : '이 메시지 신고'),
                onTap: () {
                  Navigator.of(sheet).pop();
                  showReportSheet(context, targetType: 'message', targetId: m.id);
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([_chat, _app]),
      builder: (context, _) {
        final conv = _app.conversationById(widget.conversationId);
        final myId = _app.me?.userId;
        final group = conv?.isGroup ?? false;
        final messages = _chat.messages;
        final pending = _chat.pending;
        final total = messages.length + pending.length;
        final canSend = conv?.canSend ?? true;

        Widget list;
        if (_chat.loading && messages.isEmpty) {
          list = const StateView.loading();
        } else if (_chat.error != null && messages.isEmpty && pending.isEmpty) {
          list = StateView(
            icon: Icons.cloud_off_outlined,
            title: '대화를 불러오지 못했어요',
            message: _chat.error,
            actions: [FilledButton(onPressed: _chat.load, child: const Text('다시 시도'))],
          );
        } else if (total == 0) {
          list = const StateView(icon: Icons.chat_bubble_outline, title: '첫 메시지를 보내 보세요');
        } else {
          list = NotificationListener<ScrollNotification>(
            onNotification: (n) {
              if (n.metrics.pixels > n.metrics.maxScrollExtent - 200) _chat.loadOlder();
              return false;
            },
            child: ListView.builder(
              reverse: true,
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              itemCount: total + 1,
              itemBuilder: (context, index) {
                if (index == total) {
                  return _chat.loadingOlder
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
                        )
                      : const SizedBox(height: 4);
                }
                final i = total - 1 - index; // 시간순 위치
                if (i >= messages.length) {
                  final p = pending[i - messages.length];
                  return _PendingBubble(pending: p, onRetry: () => _app.retry(p), onDiscard: () => _app.discard(p));
                }
                final m = messages[i];
                final mine = m.senderId == myId;
                final prev = i > 0 ? messages[i - 1] : null;
                final newDay =
                    prev == null ||
                    prev.createdAt.day != m.createdAt.day ||
                    prev.createdAt.month != m.createdAt.month ||
                    prev.createdAt.year != m.createdAt.year;
                final read = !group && mine && conv != null && m.seq <= conv.peerReadSeq;
                final showName = group && !mine && !m.isSystem && (prev == null || prev.senderId != m.senderId || prev.isSystem || newDay);
                final quoted = _chat.byId(m.replyToId);
                return Column(
                  children: [
                    if (newDay)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          '${m.createdAt.year}년 ${m.createdAt.month}월 ${m.createdAt.day}일',
                          style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                        ),
                      ),
                    if (m.isSystem)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text(m.body, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                      )
                    else
                      _Bubble(
                        message: m,
                        mine: mine,
                        senderName: showName ? m.senderNickname : null,
                        quoted: m.replyToId == null ? null : (quoted?.preview ?? '이전 메시지'),
                        footer: mine ? '${read ? '읽음 · ' : ''}${clockTime(m.createdAt)}' : clockTime(m.createdAt),
                        onLongPress: m.hidden || m.masked ? null : () => _messageMenu(m, mine, conv),
                      ),
                  ],
                );
              },
            ),
          );
        }

        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: InkWell(
              onTap: conv == null
                  ? null
                  : group
                  ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RoomDetailPage(roomId: conv.id)))
                  : conv.peerActive
                  ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProfilePage(userId: conv.peerId)))
                  : null,
              child: Row(
                children: [
                  Avatar(name: conv?.title ?? widget.title, colorIndex: conv?.peerColor ?? 0, size: 36, mediaId: group ? conv?.roomImage : conv?.peerPhoto),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(conv?.title ?? widget.title, overflow: TextOverflow.ellipsis),
                        if (group && conv != null)
                          Text('${conv.memberCount}명 참여 중', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  if (conv?.muted ?? false)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Icon(Icons.notifications_off_outlined, size: 16, color: t.colorScheme.outline),
                    ),
                ],
              ),
            ),
            actions: [
              IconButton(onPressed: _search, icon: const Icon(Icons.search), tooltip: '대화 내 검색'),
              if (conv != null)
                PopupMenuButton<String>(
                  onSelected: (v) {
                    if (v == 'mute') _toggleMute(conv);
                    if (v == 'export') _export();
                    if (v == 'leave') _leave(conv);
                    if (v == 'room') Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RoomDetailPage(roomId: conv.id)));
                    if (v == 'block') _block(conv);
                    if (v == 'gift') showGiftDialog(context, conversationId: conv.id, peerName: conv.title);
                    if (v == 'report') showReportSheet(context, targetType: group ? 'room' : 'profile', targetId: group ? conv.id : conv.peerId);
                  },
                  itemBuilder: (context) => [
                    if (!group && !conv.blockedByMe) const PopupMenuItem(value: 'gift', child: Text('포인트 선물하기')),
                    PopupMenuItem(value: 'mute', child: Text(conv.muted ? '알림 켜기' : '알림 끄기')),
                    const PopupMenuItem(value: 'export', child: Text('대화 내용 내보내기(TXT)')),
                    if (group) const PopupMenuItem(value: 'room', child: Text('방 정보·나가기')) else const PopupMenuItem(value: 'leave', child: Text('방 나가기')),
                    if (!group && !conv.blockedByMe) const PopupMenuItem(value: 'block', child: Text('차단')),
                    const PopupMenuItem(value: 'report', child: Text('신고')),
                  ],
                ),
            ],
          ),
          body: SafeArea(
            child: ContentWidth(
              child: Column(
                children: [
                  if (!_app.connected)
                    Container(
                      width: double.infinity,
                      color: t.colorScheme.surfaceContainerHighest,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                      child: Text('연결이 끊겼어요. 보낸 메시지는 저장해 두었다가 연결되면 전송합니다.', style: t.textTheme.bodySmall),
                    ),
                  Expanded(child: list),
                  if (_replyTo != null)
                    Container(
                      color: t.colorScheme.surfaceContainerHighest,
                      padding: const EdgeInsets.fromLTRB(16, 6, 4, 6),
                      child: Row(
                        children: [
                          Icon(Icons.reply, size: 18, color: t.colorScheme.primary),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(_replyTo!.preview, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.textTheme.bodySmall),
                          ),
                          IconButton(onPressed: () => setState(() => _replyTo = null), icon: const Icon(Icons.close, size: 18), tooltip: '답장 취소'),
                        ],
                      ),
                    ),
                  if (canSend)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 6, 8, 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          IconButton(
                            onPressed: _sendingPhoto ? null : _sendPhoto,
                            icon: _sendingPhoto
                                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                                : const Icon(Icons.add_photo_alternate_outlined),
                            tooltip: '사진 보내기',
                          ),
                          Expanded(
                            child: TextField(
                              controller: _input,
                              minLines: 1,
                              maxLines: 5,
                              maxLength: 2000,
                              textInputAction: TextInputAction.newline,
                              decoration: const InputDecoration(
                                hintText: '메시지 입력',
                                counterText: '',
                                contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                              ),
                              onChanged: (v) {
                                _app.saveDraft(widget.conversationId, v);
                                setState(() {});
                              },
                            ),
                          ),
                          const SizedBox(width: 6),
                          IconButton.filled(onPressed: _input.text.trim().isEmpty ? null : _send, icon: const Icon(Icons.arrow_upward), tooltip: '보내기'),
                        ],
                      ),
                    )
                  else
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      color: t.colorScheme.surfaceContainerHighest,
                      child: Text(
                        conv != null && conv.blockedByMe
                            ? '차단한 회원입니다. 내 정보 > 차단 목록에서 해제할 수 있어요.'
                            : group
                            ? '종료된 방입니다.'
                            : '메시지를 보낼 수 없는 대화입니다.',
                        textAlign: TextAlign.center,
                        style: t.textTheme.bodyMedium,
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.mine, required this.footer, this.senderName, this.quoted, this.onLongPress});
  final Message message;
  final bool mine;
  final String footer;
  final String? senderName;
  final String? quoted;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final m = message;
    final muted = m.hidden || m.masked;
    final bg = muted ? t.colorScheme.surfaceContainerLow : (mine ? t.colorScheme.primary : t.colorScheme.surfaceContainerHighest);
    final fg = muted ? t.colorScheme.outline : (mine ? t.colorScheme.onPrimary : t.colorScheme.onSurface);
    final ctx = m.marketContext;
    final radius = BorderRadius.only(
      topLeft: const Radius.circular(18),
      topRight: const Radius.circular(18),
      bottomLeft: Radius.circular(mine ? 18 : 4),
      bottomRight: Radius.circular(mine ? 4 : 18),
    );

    Widget content;
    if (m.hidden) {
      content = Text('운영 정책에 따라 숨겨진 메시지입니다', style: t.textTheme.bodyMedium?.copyWith(color: fg));
    } else if (m.masked) {
      content = Text('차단한 회원의 메시지입니다', style: t.textTheme.bodyMedium?.copyWith(color: fg));
    } else if (m.isImage) {
      content = GestureDetector(
        onTap: () => openPhoto(context, m.mediaId!),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: MediaImage(mediaId: m.mediaId!, width: 220, height: 220),
        ),
      );
    } else if (m.kind == 'gift') {
      content = Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.card_giftcard, color: fg, size: 22),
          const SizedBox(width: 8),
          Flexible(child: Text(m.body, style: t.textTheme.bodyLarge?.copyWith(color: fg, fontWeight: FontWeight.w600))),
        ],
      );
    } else {
      content = Text(m.body, style: t.textTheme.bodyLarge?.copyWith(color: fg));
    }

    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width.clamp(0, 720) * 0.76),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Column(
            crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
            children: [
              if (senderName != null)
                Padding(
                  padding: const EdgeInsets.only(left: 4, bottom: 2, top: 4),
                  child: Text(senderName!, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ),
              GestureDetector(
                onLongPress: onLongPress,
                child: Container(
                  padding: m.isImage && !muted ? const EdgeInsets.all(4) : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(color: bg, borderRadius: radius),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (ctx != null && !muted)
                        // 어느 물건에 대한 문의인지 바로 보이도록 상품 정보를 붙인다.
                        Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(color: fg.withAlpha(28), borderRadius: BorderRadius.circular(10)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (ctx['thumbMediaId'] != null)
                                Padding(
                                  padding: const EdgeInsets.only(right: 8),
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(6),
                                    child: MediaImage(mediaId: ctx['thumbMediaId'] as String, width: 40, height: 40),
                                  ),
                                ),
                              Flexible(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('거래 문의', style: t.textTheme.labelSmall?.copyWith(color: fg.withAlpha(190))),
                                    Text(
                                      '${ctx['title']}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: t.textTheme.labelLarge?.copyWith(color: fg),
                                    ),
                                    if (ctx['price'] != null) Text(won(ctx['price'] as num), style: t.textTheme.labelMedium?.copyWith(color: fg)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        )
                      else if (m.kind == 'greeting' && !muted)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text('인사말', style: t.textTheme.labelSmall?.copyWith(color: fg.withAlpha(180))),
                        ),
                      if (quoted != null && !muted)
                        Container(
                          margin: const EdgeInsets.only(bottom: 6),
                          padding: const EdgeInsets.only(left: 8),
                          decoration: BoxDecoration(
                            border: Border(left: BorderSide(color: fg.withAlpha(120), width: 2)),
                          ),
                          child: Text(
                            quoted!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: t.textTheme.bodySmall?.copyWith(color: fg.withAlpha(200)),
                          ),
                        ),
                      content,
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
                child: Text(footer, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 전송 중 · 전송 대기 · 실패를 구분해서 보여준다.
class _PendingBubble extends StatelessWidget {
  const _PendingBubble({required this.pending, required this.onRetry, required this.onDiscard});
  final PendingMessage pending;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget footer;
    switch (pending.state) {
      case PendingState.sending:
        footer = Text('전송 중…', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant));
        break;
      case PendingState.queued:
        footer = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.schedule, size: 12, color: t.colorScheme.onSurfaceVariant),
            const SizedBox(width: 4),
            Text('연결되면 전송', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ],
        );
        break;
      case PendingState.failed:
        footer = Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 4,
          children: [
            Icon(Icons.error_outline, size: 14, color: t.colorScheme.error),
            Text(pending.error ?? '전송 실패', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.error)),
            TextButton(
              onPressed: onRetry,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('다시 보내기'),
            ),
            TextButton(
              onPressed: onDiscard,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('삭제'),
            ),
          ],
        );
        break;
    }
    return Opacity(
      opacity: pending.state == PendingState.failed ? 1 : 0.7,
      child: Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width.clamp(0, 720) * 0.76),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(color: t.colorScheme.primary, borderRadius: BorderRadius.circular(18)),
                  child: Text(pending.text, style: t.textTheme.bodyLarge?.copyWith(color: t.colorScheme.onPrimary)),
                ),
                Padding(padding: const EdgeInsets.only(top: 2, right: 4), child: footer),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SearchSheet extends StatefulWidget {
  const _SearchSheet({required this.conversationId});
  final String conversationId;

  @override
  State<_SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<_SearchSheet> {
  final _q = TextEditingController();
  List<Message>? _results;
  bool _busy = false;

  Future<void> _run() async {
    final q = _q.text.trim();
    if (q.isEmpty) return;
    setState(() => _busy = true);
    try {
      final res = await AppScope.read(context).api.get('/v1/conversations/${widget.conversationId}/messages', query: {'q': q, 'limit': '50'});
      if (mounted) setState(() => _results = (res['items'] as List).map((e) => Message.fromJson(e as Map<String, dynamic>)).toList().reversed.toList());
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final results = _results;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.6,
        child: Column(
          children: [
            TextField(
              controller: _q,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _run(),
              decoration: InputDecoration(
                hintText: '대화 내용 검색',
                suffixIcon: IconButton(onPressed: _busy ? null : _run, icon: const Icon(Icons.search)),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: results == null
                  ? const StateView(icon: Icons.search, title: '찾을 말을 입력하세요')
                  : results.isEmpty
                  ? const StateView(icon: Icons.search_off, title: '찾는 내용이 없어요')
                  : ListView(
                      children: [
                        for (final m in results)
                          ListTile(
                            dense: true,
                            title: Text(m.body, maxLines: 2, overflow: TextOverflow.ellipsis),
                            subtitle: Text('${m.senderNickname} · ${shortTime(m.createdAt)}', style: t.textTheme.bodySmall),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
