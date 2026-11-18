import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// 서버와의 실시간 연결. 끊기면 점점 간격을 늘려가며 다시 붙는다.
/// 여기로 오는 것은 "알림"일 뿐이고, 놓친 메시지는 재연결 직후 REST 동기화로 채운다.
class Realtime {
  Realtime({
    required this.uri,
    required this.token,
    required this.onEvent,
    required this.onState,
  });

  final Uri Function() uri;
  final String token;
  final void Function(String type, Map<String, dynamic> data) onEvent;
  final void Function(bool ready) onState;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _pingTimer;
  Timer? _retryTimer;
  int _attempt = 0;
  bool _closed = false;
  bool _connecting = false;
  bool ready = false;
  DateTime _lastSeen = DateTime.now();

  void start() => _connect();

  /// 앱이 다시 앞으로 왔을 때 등, 기다리지 않고 바로 재연결을 시도한다.
  void kick() {
    if (_closed || ready || _connecting) return;
    _retryTimer?.cancel();
    _attempt = 0;
    _connect();
  }

  Future<void> _connect() async {
    if (_closed || _connecting) return;
    _connecting = true;
    _teardown();
    try {
      final channel = WebSocketChannel.connect(uri());
      _channel = channel;
      await channel.ready.timeout(const Duration(seconds: 10));
      if (_closed || !identical(_channel, channel)) {
        channel.sink.close();
        return;
      }
      _lastSeen = DateTime.now();
      _sub = channel.stream.listen(
        _onData,
        onDone: _onLost,
        onError: (Object _) => _onLost(),
        cancelOnError: true,
      );
      channel.sink.add(jsonEncode({'type': 'auth', 'token': token}));
      _pingTimer = Timer.periodic(const Duration(seconds: 20), (_) {
        if (DateTime.now().difference(_lastSeen) >
            const Duration(seconds: 50)) {
          _onLost();
          return;
        }
        try {
          channel.sink.add(jsonEncode({'type': 'ping'}));
        } catch (_) {
          _onLost();
        }
      });
    } catch (_) {
      _connecting = false;
      _onLost();
      return;
    } finally {
      _connecting = false;
    }
  }

  void _onData(dynamic raw) {
    _lastSeen = DateTime.now();
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final type = (msg['type'] ?? '') as String;
    final data =
        (msg['data'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    if (type == 'pong') return;
    if (type == 'ready') {
      _attempt = 0;
      ready = true;
      onState(true);
      return;
    }
    onEvent(type, data);
  }

  void _onLost() {
    if (_closed) return;
    _teardown();
    if (ready) {
      ready = false;
      onState(false);
    }
    if (_retryTimer?.isActive ?? false) return;
    const steps = [1, 2, 4, 8, 15];
    final wait = steps[_attempt < steps.length ? _attempt : steps.length - 1];
    _attempt++;
    _retryTimer = Timer(Duration(seconds: wait), _connect);
  }

  void _teardown() {
    _pingTimer?.cancel();
    _pingTimer = null;
    _sub?.cancel();
    _sub = null;
    try {
      _channel?.sink.close();
    } catch (_) {
      // 이미 닫힌 소켓
    }
    _channel = null;
  }

  void dispose() {
    _closed = true;
    _retryTimer?.cancel();
    _teardown();
  }
}
