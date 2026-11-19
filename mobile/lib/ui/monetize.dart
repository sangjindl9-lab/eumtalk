import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/models.dart';
import 'points.dart' show PointsPage;
import 'profile_page.dart';
import 'widgets.dart';

String _err(Object e) => e is ApiException ? e.message : e.toString();

/// VIP 배지(목록·프로필 이름 옆)
class VipBadge extends StatelessWidget {
  const VipBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: const Color(0xFFE8A33D), borderRadius: BorderRadius.circular(6)),
      child: Text('VIP', style: t.textTheme.labelSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
    );
  }
}

/// 부스트 중 표시(목록 카드)
class BoostTag extends StatelessWidget {
  const BoostTag({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.rocket_launch_outlined, size: 14, color: t.colorScheme.primary),
        const SizedBox(width: 2),
        Text('지금 주목', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w600)),
      ],
    );
  }
}

/// 프로필 부스트 안내·구매 시트. 부스트했으면 true.
Future<bool> showBoostSheet(BuildContext context) async {
  final app = AppScope.read(context);
  Map<String, dynamic> s;
  try {
    s = await app.api.get('/v1/me/boost');
  } catch (e) {
    if (context.mounted) showMessage(context, _err(e));
    return false;
  }
  if (!context.mounted) return false;
  final done = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      final t = Theme.of(ctx);
      final until = s['boostUntil'] == null ? null : DateTime.tryParse(s['boostUntil'] as String)?.toLocal();
      final enough = s['enough'] == true;
      final discount = (s['vipDiscountPercent'] as num?)?.toInt() ?? 0;
      var busy = false;
      return StatefulBuilder(
        builder: (ctx, setSheet) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.rocket_launch_outlined, size: 40, color: t.colorScheme.primary),
                const SizedBox(height: 8),
                Text('내 프로필 띄우기', textAlign: TextAlign.center, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                Text(
                  '${s['minutes']}분 동안 주변 사람 목록 맨 위에 내 프로필이 "지금 주목"으로 보여요.\n이미 부스트 중이면 시간이 이어서 늘어나요.',
                  textAlign: TextAlign.center,
                  style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                ),
                if (until != null) ...[
                  const SizedBox(height: 10),
                  Text('지금 부스트 중 · ${TimeOfDay.fromDateTime(until).format(ctx)}까지', textAlign: TextAlign.center, style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary)),
                ],
                if (s['visible'] != true) ...[
                  const SizedBox(height: 10),
                  Text('지금은 "주변 사람에 내 프로필 표시"가 꺼져 있어요. 내 정보 → 공개 범위에서 켜 주세요.', textAlign: TextAlign.center, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
                ],
                const SizedBox(height: 20),
                FilledButton(
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                  onPressed: busy || s['visible'] != true
                      ? null
                      : enough
                      ? () async {
                          setSheet(() => busy = true);
                          try {
                            final r = await app.api.post('/v1/me/boost');
                            await app.refreshMe();
                            if (ctx.mounted) Navigator.of(ctx).pop(true);
                            if (context.mounted) showMessage(context, '부스트 시작! 잔여 ${r['balance']}P');
                          } catch (e) {
                            setSheet(() => busy = false);
                            if (context.mounted) showMessage(context, _err(e));
                          }
                        }
                      : () {
                          Navigator.of(ctx).pop(false);
                          Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PointsPage()));
                        },
                  child: Text(enough ? '${s['unitPrice']}P로 ${s['minutes']}분 띄우기${discount > 0 ? ' (VIP $discount% 할인)' : ''}' : '포인트 충전하기 (보유 ${s['balance']}P)'),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
  return done == true;
}

/// 나를 본 사람: 오늘·이번 주 방문자 수(무료), 목록은 열람권 또는 VIP.
class VisitorsPage extends StatefulWidget {
  const VisitorsPage({super.key});

  @override
  State<VisitorsPage> createState() => _VisitorsPageState();
}

class _VisitorsPageState extends State<VisitorsPage> {
  Map<String, dynamic>? _d;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final d = await AppScope.read(context).api.get('/v1/me/visitors');
      if (mounted) setState(() => (_d = d, _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = _err(e));
    }
  }

  Future<void> _unlock() async {
    setState(() => _busy = true);
    try {
      final d = await AppScope.read(context).api.post('/v1/me/visitors/unlock');
      if (mounted) setState(() => _d = d);
    } catch (e) {
      if (mounted) showMessage(context, _err(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final d = _d;
    if (d == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('나를 본 사람')),
        body: _error == null ? const StateView.loading() : StateView(icon: Icons.cloud_off_outlined, title: '불러오지 못했어요', message: _error, actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))]),
      );
    }
    final items = (d['items'] as List).cast<Map>();
    final unlocked = d['unlocked'] == true;
    return Scaffold(
      appBar: AppBar(title: const Text('나를 본 사람')),
      body: ContentWidth(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  child: Row(
                    children: [
                      for (final (label, v) in [('오늘', d['today']), ('최근 7일', d['week'])])
                        Expanded(
                          child: Column(
                            children: [
                              Text('$v명', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
                              Text(label, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              if (!unlocked) ...[
                Text('누가 내 프로필을 봤는지 궁금하다면', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text('${d['price']}P로 24시간 동안 최근 7일 방문자를 볼 수 있어요. VIP는 언제나 무료예요.', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                if (d['leaveFootprints'] != true) ...[
                  const SizedBox(height: 8),
                  Text('"내 방문 기록 남기기"를 끈 상태에서는 볼 수 없어요. 내 정보 → 공개 범위에서 켜 주세요.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
                ],
                const SizedBox(height: 12),
                FilledButton(
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  onPressed: _busy || d['leaveFootprints'] != true || (d['week'] as num) == 0 ? null : _unlock,
                  child: Text((d['week'] as num) == 0 ? '아직 방문자가 없어요' : '${d['price']}P로 방문자 보기 (보유 ${d['balance']}P)'),
                ),
              ] else ...[
                Text(
                  d['vip'] == true ? 'VIP 혜택으로 방문자를 보고 있어요' : '방문자 보기 이용 중',
                  style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary),
                ),
                const SizedBox(height: 8),
                if (items.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('최근 7일 방문자가 없어요'))),
                for (final it in items)
                  Builder(
                    builder: (context) {
                      final p = PublicProfile.fromJson((it['profile'] as Map).cast<String, dynamic>());
                      final at = DateTime.parse(it['viewedAt'] as String).toLocal();
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Avatar(name: p.nickname, colorIndex: p.avatarColor, size: 44, mediaId: p.photoMediaId),
                        title: Row(children: [Flexible(child: Text(p.nickname)), if (p.vip) ...[const SizedBox(width: 6), const VipBadge()]]),
                        subtitle: Text('${p.ageBand} · ${p.proximityLabel} · ${at.month}/${at.day} ${TimeOfDay.fromDateTime(at).format(context)}'),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProfilePage(userId: p.userId, preview: p))),
                      );
                    },
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 오늘의 추천 친구(주변 탭 맨 위 가로 목록)
class TodayPicksStrip extends StatefulWidget {
  const TodayPicksStrip({super.key});

  @override
  State<TodayPicksStrip> createState() => _TodayPicksStripState();
}

class _TodayPicksStripState extends State<TodayPicksStrip> {
  List<PublicProfile> _items = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final r = await AppScope.read(context).api.get('/v1/me/picks');
      if (!mounted || r['enabled'] != true) return;
      setState(() => _items = (r['items'] as List).map((e) => PublicProfile.fromJson((e as Map).cast<String, dynamic>())).toList());
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) return const SizedBox.shrink();
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('오늘의 추천 친구', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          SizedBox(
            height: 128,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _items.length,
              separatorBuilder: (_, _) => const SizedBox(width: 10),
              itemBuilder: (context, i) {
                final p = _items[i];
                return SizedBox(
                  width: 104,
                  child: Card(
                    margin: EdgeInsets.zero,
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProfilePage(userId: p.userId, preview: p))),
                      child: Padding(
                        padding: const EdgeInsets.all(10),
                        child: Column(
                          children: [
                            Avatar(name: p.nickname, colorIndex: p.avatarColor, size: 52, mediaId: p.photoMediaId),
                            const SizedBox(height: 6),
                            Text(p.nickname, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.textTheme.labelLarge),
                            Text(p.ageBand, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// 대화 중 포인트 선물. 보냈으면 true.
Future<bool> showGiftDialog(BuildContext context, {required String conversationId, required String peerName}) async {
  final app = AppScope.read(context);
  const presets = [10, 50, 100, 300];
  int? amount = 50;
  final note = TextEditingController();
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) {
      final t = Theme.of(ctx);
      var busy = false;
      return StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(24, 0, 24, 24 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('$peerName 님에게 포인트 선물', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('받은 포인트는 인사 보내기 등 앱 안에서만 쓸 수 있어요. 보낸 선물은 되돌릴 수 없어요.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                children: [
                  for (final p in presets)
                    ChoiceChip(label: Text('${p}P'), selected: amount == p, onSelected: (_) => setSheet(() => amount = p)),
                ],
              ),
              const SizedBox(height: 12),
              TextField(controller: note, maxLength: 60, decoration: const InputDecoration(hintText: '한마디 (선택)', counterText: '')),
              const SizedBox(height: 16),
              FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                icon: const Icon(Icons.card_giftcard),
                onPressed: busy || amount == null
                    ? null
                    : () async {
                        setSheet(() => busy = true);
                        try {
                          final r = await app.api.post('/v1/conversations/$conversationId/gift', {
                            'points': amount,
                            if (note.text.trim().isNotEmpty) 'note': note.text.trim(),
                            'clientMsgId': 'gift${DateTime.now().microsecondsSinceEpoch}',
                          });
                          if (ctx.mounted) Navigator.of(ctx).pop(true);
                          if (context.mounted) showMessage(context, '${amount}P를 선물했어요 · 잔여 ${r['balance']}P');
                        } on ApiException catch (e) {
                          setSheet(() => busy = false);
                          if (!context.mounted) return;
                          if (e.code == 'INSUFFICIENT_POINTS') {
                            Navigator.of(ctx).pop(false);
                            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PointsPage()));
                          }
                          showMessage(context, e.message);
                        } catch (e) {
                          setSheet(() => busy = false);
                          if (context.mounted) showMessage(context, _err(e));
                        }
                      },
                label: Text('${amount ?? 0}P 선물하기'),
              ),
            ],
          ),
        ),
      );
    },
  );
  note.dispose();
  return ok == true;
}
