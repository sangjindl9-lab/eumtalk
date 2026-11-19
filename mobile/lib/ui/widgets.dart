import 'package:material_ui/material_ui.dart';

import '../core/app_state.dart';
import '../core/models.dart';
import 'media.dart';

/// 화면 어디서나 AppState 에 접근하기 위한 범위.
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState app, required super.child}) : super(notifier: app);

  /// 값이 바뀌면 다시 그려야 하는 화면에서 사용.
  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  /// 버튼 처리 등 한 번만 읽을 때 사용.
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

const _avatarColors = [
  Color(0xFF2F6B5E),
  Color(0xFFB5651D),
  Color(0xFF3F5E8C),
  Color(0xFF8C4A5E),
  Color(0xFF5E7D32),
  Color(0xFF6B4E9B),
  Color(0xFF1F7A8C),
  Color(0xFF9B5B2A),
];

class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.name, required this.colorIndex, this.size = 48, this.mediaId});
  final String name;
  final int colorIndex;
  final double size;

  /// 프로필 사진이 있으면 사진을, 없으면 닉네임 첫 글자를 보여준다.
  final String? mediaId;

  @override
  Widget build(BuildContext context) {
    final color = _avatarColors[colorIndex.abs() % _avatarColors.length];
    final initial = name.isEmpty ? '?' : name.characters.first;
    if (mediaId != null) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(size * 0.36),
        child: MediaImage(mediaId: mediaId!, width: size, height: size),
      );
    }
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(size * 0.36)),
      child: Text(
        initial,
        style: TextStyle(color: Colors.white, fontSize: size * 0.42, fontWeight: FontWeight.w700, height: 1),
      ),
    );
  }
}

/// 로딩·빈 목록·권한 거부·통신 실패를 같은 틀로 보여준다.
class StateView extends StatelessWidget {
  const StateView({super.key, required this.icon, required this.title, this.message, this.actions = const []});
  const StateView.loading({super.key}) : icon = null, title = '불러오는 중…', message = null, actions = const [];

  final IconData? icon;
  final String title;
  final String? message;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon == null)
                const Padding(padding: EdgeInsets.only(bottom: 16), child: CircularProgressIndicator())
              else
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Icon(icon, size: 44, color: t.colorScheme.outline),
                ),
              Text(title, style: t.textTheme.titleMedium, textAlign: TextAlign.center),
              if (message != null) ...[
                const SizedBox(height: 8),
                Text(
                  message!,
                  style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  textAlign: TextAlign.center,
                ),
              ],
              if (actions.isNotEmpty) ...[const SizedBox(height: 20), Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: actions)],
            ],
          ),
        ),
      ),
    );
  }
}

/// 폴드 펼친 화면·태블릿에서 내용이 지나치게 넓어지지 않게 가운데로 모은다.
class ContentWidth extends StatelessWidget {
  const ContentWidth({super.key, required this.child, this.maxWidth = 720});
  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}

void showMessage(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating));
}

String shortTime(DateTime t) {
  final now = DateTime.now();
  final hm = '${t.hour < 12 ? '오전' : '오후'} ${t.hour % 12 == 0 ? 12 : t.hour % 12}:${t.minute.toString().padLeft(2, '0')}';
  if (t.year == now.year && t.month == now.month && t.day == now.day) return hm;
  if (t.year == now.year) return '${t.month}월 ${t.day}일';
  return '${t.year}.${t.month}.${t.day}';
}

/// 12,000원 형식
String won(num v) => v == 0 ? '무료 나눔' : '${v.toInt().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',')}원';

/// 1,200 형식
String comma(num v) => v.toInt().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',');

String clockTime(DateTime t) => '${t.hour < 12 ? '오전' : '오후'} ${t.hour % 12 == 0 ? 12 : t.hour % 12}:${t.minute.toString().padLeft(2, '0')}';

/// 시·도 → 시·군·구 순서로 고르는 지역 선택. 위치 권한 없이도 쓸 수 있다.
Future<Region?> pickRegion(BuildContext context, {String? onlySido}) {
  return showModalBottomSheet<Region>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (context) => _RegionPicker(onlySido: onlySido),
  );
}

class _RegionPicker extends StatefulWidget {
  const _RegionPicker({this.onlySido});
  final String? onlySido;

  @override
  State<_RegionPicker> createState() => _RegionPickerState();
}

class _RegionPickerState extends State<_RegionPicker> {
  String? _sido;

  @override
  void initState() {
    super.initState();
    _sido = widget.onlySido;
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final sidos = <String>[];
    for (final r in app.regions) {
      if (!sidos.contains(r.sido)) sidos.add(r.sido);
    }
    final t = Theme.of(context);
    final items = _sido == null ? const <Region>[] : app.regions.where((r) => r.sido == _sido).toList();
    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.7,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Row(
              children: [
                if (_sido != null && widget.onlySido == null)
                  IconButton(onPressed: () => setState(() => _sido = null), icon: const Icon(Icons.arrow_back), tooltip: '시·도 다시 선택'),
                Expanded(child: Text(_sido ?? '활동 지역 선택', style: t.textTheme.titleLarge)),
              ],
            ),
          ),
          Expanded(
            child: app.regions.isEmpty
                ? const StateView.loading()
                : _sido == null
                ? ListView(
                    children: [
                      for (final s in sidos) ListTile(title: Text(s), trailing: const Icon(Icons.chevron_right), onTap: () => setState(() => _sido = s)),
                    ],
                  )
                : ListView(
                    children: [for (final r in items) ListTile(title: Text(r.sigungu), onTap: () => Navigator.of(context).pop(r))],
                  ),
          ),
        ],
      ),
    );
  }
}

/// 차단·신고 확인 등에 쓰는 간단한 확인 창.
Future<bool> confirm(BuildContext context, {required String title, required String message, required String action}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('취소')),
        FilledButton(onPressed: () => Navigator.of(context).pop(true), child: Text(action)),
      ],
    ),
  );
  return ok ?? false;
}

const reportReasons = <String, String>{
  'child': '아동 안전(미성년자·아동 착취)',
  'sexual': '성적 접근·거래 유도',
  'scam': '사기',
  'abuse': '욕설·괴롭힘',
  'spam': '스팸·광고',
  'impersonation': '사칭',
  'privacy': '개인정보 노출',
  'other': '기타',
};

/// 신고 접수. [targetType] 은 profile / message / greeting.
Future<void> showReportSheet(BuildContext context, {required String targetType, required String targetId}) async {
  final app = AppScope.read(context);
  String? reason;
  final detail = TextEditingController();
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('신고 사유', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text('신고한 내용과 시점은 운영 담당자만 확인합니다.', style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final e in reportReasons.entries)
                    ChoiceChip(label: Text(e.value), selected: reason == e.key, onSelected: (_) => setState(() => reason = e.key)),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: detail,
                maxLines: 3,
                maxLength: 300,
                decoration: const InputDecoration(hintText: '자세한 내용(선택)'),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: reason == null
                      ? null
                      : () async {
                          try {
                            await app.api.post('/v1/reports', {'targetType': targetType, 'targetId': targetId, 'reason': reason, 'detail': detail.text});
                            if (context.mounted) {
                              Navigator.of(context).pop(true);
                            }
                          } catch (e) {
                            if (context.mounted) {
                              showMessage(context, e.toString());
                            }
                          }
                        },
                  child: const Text('신고하기'),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
  if (sent == true && context.mounted) showMessage(context, '신고가 접수되었습니다.');
}

/// 남녀 구분 색: 여자 분홍, 남자 파랑
Color genderColor(String? gender) => gender == 'female' ? const Color(0xFFE0457B) : gender == 'male' ? const Color(0xFF2F7BD8) : Colors.grey;

/// 이름 옆 남녀 표시(♀ 여 / ♂ 남)
class GenderMark extends StatelessWidget {
  const GenderMark(this.gender, {super.key, this.size = 16, this.showText = true});
  final String? gender;
  final double size;
  final bool showText;

  @override
  Widget build(BuildContext context) {
    if (gender != 'male' && gender != 'female') return const SizedBox.shrink();
    final c = genderColor(gender);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: showText ? 6 : 2, vertical: 1),
      decoration: BoxDecoration(color: c.withAlpha(28), borderRadius: BorderRadius.circular(6)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(gender == 'female' ? Icons.female : Icons.male, size: size, color: c),
          if (showText) Text(gender == 'female' ? '여' : '남', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: c, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}
