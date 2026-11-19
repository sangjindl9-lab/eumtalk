import 'dart:io';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import 'api.dart';

/// 앱 버전 확인·업데이트 안내. 서버(/v1/app-config)의 최신·필수 버전과 내 버전 번호를 비교한다.
class AppUpdate {
  static const _ch = MethodChannel('eumtalk/app');
  static int? _build;
  static String _name = '';
  static bool _shownThisRun = false;

  static String get versionName => _name;
  static int? get build => _build;

  static Future<int?> loadVersion() async {
    if (_build != null) return _build;
    try {
      final r = await _ch.invokeMapMethod<String, dynamic>('versionInfo');
      _build = (r?['build'] as num?)?.toInt();
      _name = (r?['name'] ?? '') as String;
    } catch (_) {
      // iOS·웹 등 채널이 없는 환경
    }
    return _build;
  }

  static Future<void> openStore([String? url]) async {
    try {
      await _ch.invokeMethod('openStore', {'url': ?url});
    } catch (_) {}
  }

  /// Google Play 에 새 버전이 있는지(Play 에서 설치한 앱만). 알 수 없으면 null.
  static Future<Map<String, dynamic>?> playUpdate() async {
    try {
      return await _ch.invokeMapMethod<String, dynamic>('playUpdateInfo');
    } catch (_) {
      return null;
    }
  }

  /// 새 버전 정보. 없거나 최신이면 null.
  /// 1) Google Play 가 알려 주는 새 버전(관리자 등록 없이 자동)
  /// 2) 관리자 화면에 등록한 최신·필수 버전(안내 문구, 필수 업데이트)
  static Future<Map<String, dynamic>?> check(ApiClient api) async {
    final mine = await loadVersion();
    if (mine == null) return null;
    Map<String, dynamic> info = const {};
    try {
      final cfg = await api.get('/v1/app-config');
      info = ((cfg['update'] as Map?)?[Platform.isIOS ? 'ios' : 'android'] as Map?)?.cast<String, dynamic>() ?? const {};
    } catch (_) {}
    final serverLatest = (info['latestBuild'] as num?)?.toInt() ?? 0;
    final minBuild = (info['minBuild'] as num?)?.toInt() ?? 0;
    final play = Platform.isAndroid ? await playUpdate() : null;
    final playAvailable = play?['available'] == true;
    final playCode = (play?['versionCode'] as num?)?.toInt() ?? 0;
    if (!playAvailable && serverLatest <= mine) return null;
    // 서버에 등록한 버전보다 Play 버전이 더 새로우면 서버 안내 문구는 쓰지 않는다.
    final useServerText = serverLatest > mine && (playCode == 0 || serverLatest >= playCode);
    return {
      'latestName': useServerText ? (info['latestName'] ?? '') : '',
      'notes': useServerText ? (info['notes'] ?? '') : '',
      'storeUrl': info['storeUrl'],
      'forced': mine < minBuild,
    };
  }

  /// 앱 실행 중 한 번만 안내한다. 필수 업데이트면 닫을 수 없다.
  static Future<void> prompt(BuildContext context, ApiClient api, {bool force = false}) async {
    if (_shownThisRun && !force) return;
    Map<String, dynamic>? info;
    try {
      info = await check(api);
    } catch (_) {
      return;
    }
    if (info == null) {
      if (force && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('최신 버전을 쓰고 있어요')));
      }
      return;
    }
    _shownThisRun = true;
    if (!context.mounted) return;
    final forced = info['forced'] == true;
    final name = (info['latestName'] ?? '') as String;
    final notes = (info['notes'] ?? '') as String;
    await showDialog<void>(
      context: context,
      barrierDismissible: !forced,
      builder: (ctx) => PopScope(
        canPop: !forced,
        child: AlertDialog(
          icon: const Icon(Icons.system_update_outlined),
          title: Text(forced ? '업데이트가 필요해요' : '새 버전이 나왔어요${name.isEmpty ? '' : ' ($name)'}'),
          content: Text(
            [
              if (notes.isNotEmpty) notes,
              forced ? '이 버전은 더 이상 쓸 수 없어요. 스토어에서 업데이트해 주세요.' : '스토어에서 업데이트하면 새 기능을 쓸 수 있어요.',
            ].join('\n\n'),
          ),
          actions: [
            if (!forced) TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('나중에')),
            FilledButton(onPressed: () => openStore(info!['storeUrl'] as String?), child: const Text('업데이트')),
          ],
        ),
      ),
    );
  }
}
