import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'api.dart';

/// 푸시 알림(FCM). Firebase 설정값은 빌드할 때 --dart-define 으로 넣는다(google-services.json 불필요).
///   FIREBASE_PROJECT_ID, FIREBASE_SENDER_ID, FIREBASE_API_KEY, FIREBASE_ANDROID_APP_ID, FIREBASE_IOS_APP_ID
/// 값이 없으면 푸시 없이 동작한다(앱이 켜져 있을 때는 실시간 연결로 받는다).
///
/// 서버는 FCM HTTP v1 의 기기 토큰(token)으로 보내므로 토큰 API를 쓴다.
/// (firebase_messaging 17 에서 FID 방식 API가 새로 생기며 토큰 API가 사용 중단 예정으로 표시되었다.)
// ignore_for_file: deprecated_member_use
class PushService {
  static const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const _senderId = String.fromEnvironment('FIREBASE_SENDER_ID');
  static const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const _androidAppId = String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
  static const _iosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
  static const _iosBundleId = String.fromEnvironment('IOS_BUNDLE_ID', defaultValue: 'kr.eumsoft.eumtalk');

  static bool get configured =>
      _projectId.isNotEmpty && _senderId.isNotEmpty && _apiKey.isNotEmpty && (Platform.isIOS ? _iosAppId.isNotEmpty : _androidAppId.isNotEmpty);

  bool _ready = false;
  String? _token;
  StreamSubscription<String>? _refreshSub;
  StreamSubscription<RemoteMessage>? _openSub;

  /// 알림을 눌렀을 때 호출된다. data 에는 서버가 넣은 kind·conversationId 등이 들어 있다.
  void Function(Map<String, dynamic> data)? onOpen;

  Future<void> init() async {
    if (_ready || !configured) return;
    try {
      await Firebase.initializeApp(
        options: FirebaseOptions(
          apiKey: _apiKey,
          appId: Platform.isIOS ? _iosAppId : _androidAppId,
          messagingSenderId: _senderId,
          projectId: _projectId,
          iosBundleId: Platform.isIOS ? _iosBundleId : null,
        ),
      );
      // 앱이 앞에 있을 때는 시스템 알림을 띄우지 않는다(대화 화면·배지로 이미 보인다).
      await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(alert: false, badge: true, sound: false);
      _openSub = FirebaseMessaging.onMessageOpenedApp.listen((m) => onOpen?.call(m.data));
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      _ready = true;
      if (initial != null) {
        // 앱이 꺼진 상태에서 알림을 눌러 실행된 경우: 첫 화면이 그려진 뒤 연다.
        Future<void>.delayed(const Duration(milliseconds: 600), () => onOpen?.call(initial.data));
      }
    } catch (_) {
      _ready = false;
    }
  }

  /// 로그인 후 호출: 알림 권한을 묻고(Android 13+, iOS) 기기 토큰을 서버에 등록한다.
  Future<void> register(ApiClient api) async {
    await init();
    if (!_ready) return;
    try {
      final settings = await FirebaseMessaging.instance.requestPermission(alert: true, badge: true, sound: true);
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;
      if (Platform.isIOS) {
        // iOS는 APNs 토큰이 먼저 준비되어야 FCM 토큰을 받을 수 있다.
        for (var i = 0; i < 10 && await FirebaseMessaging.instance.getAPNSToken() == null; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 500));
        }
      }
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _send(api, token);
      await _refreshSub?.cancel();
      _refreshSub = FirebaseMessaging.instance.onTokenRefresh.listen((t) => _send(api, t));
    } catch (_) {
      // 알림 등록에 실패해도 앱 사용에는 지장이 없다. 다음 로그인 때 다시 시도한다.
    }
  }

  Future<void> _send(ApiClient api, String token) async {
    _token = token;
    try {
      await api.post('/v1/devices', {'token': token, 'platform': Platform.isIOS ? 'ios' : 'android'});
    } catch (_) {
      // 다음 실행 때 다시 등록한다.
    }
  }

  /// 로그아웃 시: 서버에서 이 기기 토큰을 지우고, 기기 토큰도 새로 바꾼다.
  Future<void> unregister(ApiClient api) async {
    await _refreshSub?.cancel();
    _refreshSub = null;
    final token = _token;
    _token = null;
    if (!_ready) return;
    try {
      if (token != null) await api.post('/v1/devices/remove', {'token': token});
    } catch (_) {
      // 서버에 닿지 않아도 기기 토큰은 지운다.
    }
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }

  /// 휴대폰 설정에서 이 앱의 알림을 막았는지. 알 수 없으면 null.
  Future<bool?> blockedBySystem() async {
    await init();
    if (!_ready) return null;
    try {
      final s = await FirebaseMessaging.instance.getNotificationSettings();
      return s.authorizationStatus == AuthorizationStatus.denied;
    } catch (_) {
      return null;
    }
  }

  /// 알림 권한을 다시 묻고 토큰을 등록한다(설정 화면에서 알림을 켤 때).
  Future<void> ensureRegistered(ApiClient api) => register(api);

  void dispose() {
    _refreshSub?.cancel();
    _openSub?.cancel();
  }
}
