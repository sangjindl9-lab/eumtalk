import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart' show rootBundle;

/// 앱 이름·색상·운영사 정보. 저장소의 brand/brand.json 을 고치고 tool/bootstrap.py 를 다시 돌리면 한 번에 바뀐다.
class Brand {
  Brand(this.raw);
  final Map<String, dynamic> raw;

  static Brand instance = Brand(const {});

  static Future<void> load() async {
    try {
      instance = Brand(
        jsonDecode(await rootBundle.loadString('assets/brand.json'))
            as Map<String, dynamic>,
      );
    } catch (_) {
      instance = Brand(const {});
    }
  }

  String get appName => (raw['appName'] ?? '이음톡') as String;
  String get appNameEn => (raw['appNameEn'] ?? 'EUM TALK') as String;
  String get tagline => (raw['tagline'] ?? '') as String;
  Color get seed => _color(raw['seedColor'], const Color(0xFF2F6B5E));
  Color get accent => _color(raw['accentColor'], const Color(0xFFE8A33D));
  Map<String, dynamic> get operator =>
      (raw['operator'] as Map?)?.cast<String, dynamic>() ?? const {};

  static Color _color(dynamic hex, Color fallback) {
    if (hex is! String) return fallback;
    final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
    return v == null ? fallback : Color(0xFF000000 | v);
  }
}
