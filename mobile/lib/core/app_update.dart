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

  /// 새 버전 정보. 없거나 최신이면 null.
  static Future<Map<String, dynamic>?> check(ApiClient api) async {
    final mine = await loadVersion();
    if (mine == null) return null;
    final cfg = await api.get('/v1/app-config');
    final info = ((cfg['update'] as Map?)?[Platform.isIOS ? 'ios' : 'android'] as Map?)?.cast<String, dynamic>();
    if (info == null) return null;
    final latest = (info['latestBuild'] as num?)?.toInt() ?? 0;
    if (latest <= mine) return null;
    return {...info, 'forced': mine < ((info['minBuild'] as num?)?.toInt() ?? 0)};
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
