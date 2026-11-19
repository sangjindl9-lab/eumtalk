import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:share_plus/share_plus.dart';

import '../core/api.dart';
import 'widgets.dart';

typedef _Json = Map<String, dynamic>;

String _err(Object e) => e is ApiException ? e.message : e.toString();

/// 친구 초대: 내 초대 코드·공유, 초대 현황, (가입 후 며칠 동안) 받은 코드 입력.
class InvitePage extends StatefulWidget {
  const InvitePage({super.key});

  @override
  State<InvitePage> createState() => _InvitePageState();
}

class _InvitePageState extends State<InvitePage> {
  _Json? _data;
  String? _error;
  final _code = TextEditingController();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await AppScope.read(context).api.get('/v1/me/invite');
      if (mounted) setState(() => (_data = d, _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = _err(e));
    }
  }

  Future<void> _share() async {
    final d = _data!;
    await SharePlus.instance.share(ShareParams(text: d['shareText'] as String, subject: '이음톡 초대'));
  }

  Future<void> _copy(String text, String done) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) showMessage(context, done);
  }

  Future<void> _redeem() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() => _busy = true);
    try {
      final r = await AppScope.read(context).api.post('/v1/me/invite/redeem', {'code': code});
      if (!mounted) return;
      showMessage(context, '${r['reward']}포인트를 받았어요');
      _code.clear();
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, _err(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final d = _data;
    if (d == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('친구 초대')),
        body: _error == null
            ? const StateView.loading()
            : StateView(
                icon: Icons.cloud_off_outlined,
                title: '불러오지 못했어요',
                message: _error,
                actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))],
              ),
      );
    }
    final enabled = d['enabled'] == true;
    final code = d['code'] as String;
    Widget stat(String label, Object value) => Expanded(
      child: Column(
        children: [
          Text('$value', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600, fontFeatures: const [FontFeature.tabularFigures()])),
          const SizedBox(height: 2),
          Text(label, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ],
      ),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('친구 초대')),
      body: ContentWidth(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
            children: [
              Text(
                enabled ? '친구가 내 코드로 가입하면\n친구는 ${d['inviteeReward']}P, 나는 ${d['inviterReward']}P' : '지금은 친구 초대 보상 이벤트가 쉬고 있어요',
                style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600, height: 1.35),
              ),
              const SizedBox(height: 8),
              Text(
                '내 포인트는 친구가 가입한 다음 날 이후 앱에 다시 와서 출석 체크를 하면 들어와요. 한 달에 ${d['monthlyCap']}명까지 받을 수 있어요.',
                style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 20),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      Text('내 초대 코드', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                      const SizedBox(height: 8),
                      SelectableText(code, style: t.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w600, letterSpacing: 6)),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () => _copy(code, '초대 코드를 복사했어요'),
                              icon: const Icon(Icons.copy, size: 18),
                              label: const Text('코드 복사'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () => _copy(d['link'] as String, '초대 링크를 복사했어요'),
                              icon: const Icon(Icons.link, size: 18),
                              label: const Text('링크 복사'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      FilledButton.icon(
                        onPressed: _share,
                        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                        icon: const Icon(Icons.share_outlined),
                        label: const Text('카카오톡·문자로 초대하기'),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Row(
                    children: [
                      stat('초대한 친구', d['invited']),
                      stat('보상 대기', d['pending']),
                      stat('받은 포인트', d['earned']),
                    ],
                  ),
                ),
              ),
              if (d['redeemedCode'] != null) ...[
                const SizedBox(height: 12),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.check_circle_outline),
                  title: Text('초대 코드 ${d['redeemedCode']}로 가입했어요'),
                ),
              ] else if (d['canRedeem'] == true) ...[
                const SizedBox(height: 24),
                Text('받은 초대 코드가 있나요?', style: t.textTheme.titleSmall),
                const SizedBox(height: 4),
                Text('가입 후 ${d['redeemWindowDays']}일 안에 입력하면 ${d['inviteeReward']}P를 드려요.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _code,
                        textCapitalization: TextCapitalization.characters,
                        maxLength: 6,
                        decoration: const InputDecoration(hintText: '초대 코드 6자리', counterText: ''),
                        onSubmitted: (_) => _redeem(),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(onPressed: _busy ? null : _redeem, child: const Text('받기')),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 출석 체크 카드(내 정보·포인트 화면). 하루 한 번, 연속 출석 보너스.
class AttendanceCard extends StatefulWidget {
  const AttendanceCard({super.key, this.onChecked});
  final VoidCallback? onChecked;

  @override
  State<AttendanceCard> createState() => _AttendanceCardState();
}

class _AttendanceCardState extends State<AttendanceCard> {
  _Json? _s;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final s = await AppScope.read(context).api.get('/v1/me/attendance');
      if (mounted) setState(() => _s = s);
    } catch (_) {}
  }

  Future<void> _check() async {
    setState(() => _busy = true);
    final r = await checkInAttendance(context);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (r != null) _s = (r['status'] as Map).cast<String, dynamic>();
    });
    if (r != null) widget.onChecked?.call();
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null || s['enabled'] != true) return const SizedBox.shrink();
    final t = Theme.of(context);
    final done = s['checkedToday'] == true;
    final week = (s['week'] as List).cast<Map>();
    const names = ['월', '화', '수', '목', '금', '토', '일'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('출석 체크', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        done
                            ? '${s['streak']}일 연속 출석 중 · 보너스까지 ${s['daysToBonus']}일'
                            : '매일 ${s['points']}P · ${s['streakDays']}일 연속이면 ${s['streakBonus']}P 더',
                        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                done
                    ? const Chip(avatar: Icon(Icons.check, size: 16), label: Text('오늘 완료'))
                    : FilledButton(onPressed: _busy ? null : _check, child: Text('${s['points']}P 받기')),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                for (final w in week)
                  Column(
                    children: [
                      CircleAvatar(
                        radius: 14,
                        backgroundColor: w['done'] == true ? t.colorScheme.primary : t.colorScheme.surfaceContainerHighest,
                        child: w['done'] == true ? Icon(Icons.check, size: 16, color: t.colorScheme.onPrimary) : null,
                      ),
                      const SizedBox(height: 4),
                      Text(names[DateTime.parse(w['day'] as String).weekday - 1], style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ],
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 출석 체크 요청. 성공하면 서버 응답을, 실패하면 안내 후 null.
Future<Map<String, dynamic>?> checkInAttendance(BuildContext context) async {
  final app = AppScope.read(context);
  try {
    final r = await app.api.post('/v1/me/attendance');
    if (context.mounted) {
      final bonus = (r['bonus'] as num?) ?? 0;
      showMessage(context, bonus > 0 ? '${r['streak']}일 연속 출석! 보너스 포함 ${r['points']}P를 받았어요' : '출석 완료! ${r['points']}P를 받았어요');
    }
    return r;
  } catch (e) {
    if (context.mounted) showMessage(context, _err(e));
    return null;
  }
}

/// 앱을 연 날 아직 출석하지 않았으면 하루에 한 번 출석을 권한다.
Future<void> maybePromptAttendance(BuildContext context) async {
  final app = AppScope.read(context);
  final today = DateTime.now().toIso8601String().substring(0, 10);
  if (app.prefs.getString('attendance_prompt_day') == today) return;
  _Json s;
  try {
    s = await app.api.get('/v1/me/attendance');
  } catch (_) {
    return;
  }
  if (s['enabled'] != true || s['checkedToday'] == true || !context.mounted) return;
  await app.prefs.setString('attendance_prompt_day', today);
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      final t = Theme.of(ctx);
      final streak = (s['streak'] as num).toInt();
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('오늘 출석하고 ${s['points']}P 받아 가세요', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Text(
                streak > 0 ? '지금 $streak일 연속이에요. ${s['daysToBonus']}일 더 오면 ${s['streakBonus']}P 보너스!' : '${s['streakDays']}일 연속 출석하면 ${s['streakBonus']}P 보너스를 드려요.',
                style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 20),
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                onPressed: () async {
                  Navigator.of(ctx).pop();
                  await checkInAttendance(context);
                },
                child: const Text('출석 체크'),
              ),
              TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('나중에')),
            ],
          ),
        ),
      );
    },
  );
}
