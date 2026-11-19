import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/models.dart';
import 'points.dart' show PointsPage;
import 'widgets.dart';

/// 전체 쪽지: 지역(내 주변·시·도·시·군·구), 성별, 인원(10~50명)을 골라 한 번에 인사(쪽지)를 보낸다.
/// 받는 사람 1명당 포인트가 들고, 실제로 보낸 만큼만 차감된다.
class BulkNotePage extends StatefulWidget {
  const BulkNotePage({super.key});

  @override
  State<BulkNotePage> createState() => _BulkNotePageState();
}

class _BulkNotePageState extends State<BulkNotePage> {
  static const _counts = [10, 20, 30, 40, 50];
  String? _sido; // null = 내 주변
  String? _regionId; // null = 시·도 전체
  String _gender = 'all';
  int _count = 10;
  final _text = TextEditingController();
  Map<String, dynamic>? _preview;
  bool _loading = false;
  bool _sending = false;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final app = AppScope.read(context);
      if (app.regions.isEmpty) {
        try {
          await app.loadCatalog();
        } catch (_) {}
      }
      if (mounted) setState(() {});
      _refresh();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _text.dispose();
    super.dispose();
  }

  Map<String, dynamic> get _filter => {
    if (_regionId != null) 'regionId': _regionId else if (_sido != null) 'sido': _sido else 'scope': 'near',
    if (_gender != 'all') 'genders': [_gender],
  };

  void _changed(VoidCallback f) {
    setState(f);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), _refresh);
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    try {
      final p = await AppScope.read(context).api.post('/v1/greetings/multi/preview', {'filter': _filter, 'max': _count});
      if (mounted) setState(() => _preview = p);
    } catch (e) {
      if (mounted) showMessage(context, e is ApiException ? e.message : e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.length < 2) {
      showMessage(context, '쪽지 내용을 2자 이상 써 주세요.');
      return;
    }
    final p = _preview;
    if (p == null) return;
    final n = (p['targetCount'] as num).toInt();
    if (p['enough'] != true) {
      showMessage(context, '포인트가 부족해요. 충전 화면으로 이동합니다.');
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PointsPage()));
      _refresh();
      return;
    }
    if (!await confirm(context, title: '$n명에게 쪽지를 보낼까요?', message: '${comma(p['cost'] as num)}P가 차감됩니다. 실제로 보낸 만큼만 차감돼요.', action: '보내기')) return;
    setState(() => _sending = true);
    try {
      final r = await AppScope.read(context).api.post('/v1/greetings/multi', {'filter': _filter, 'max': _count, 'text': text});
      if (!mounted) return;
      showMessage(context, '${r['sentCount']}명에게 보냈어요 · ${comma(r['cost'] as num)}P 사용');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e is ApiException ? e.message : e.toString());
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final app = AppScope.of(context);
    final sidos = <String>{for (final r in app.regions) r.sido}.toList();
    final sigungu = _sido == null ? const <Region>[] : app.regions.where((r) => r.sido == _sido).toList();
    final p = _preview;
    final n = (p?['targetCount'] as num?)?.toInt() ?? 0;
    Widget label(String s) => Padding(padding: const EdgeInsets.only(top: 20, bottom: 8), child: Text(s, style: t.textTheme.titleSmall));

    return Scaffold(
      appBar: AppBar(title: const Text('전체 쪽지')),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
          children: [
            Text('조건에 맞는 회원 여러 명에게 한 번에 쪽지(인사)를 보내요.', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            label('지역'),
            DropdownButtonFormField<String?>(
              initialValue: _sido,
              decoration: const InputDecoration(labelText: '시·도'),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('내 주변')),
                for (final s in sidos) DropdownMenuItem<String?>(value: s, child: Text(s)),
              ],
              onChanged: (v) => _changed(() {
                _sido = v;
                _regionId = null;
              }),
            ),
            if (_sido != null) ...[
              const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                key: ValueKey(_sido),
                initialValue: _regionId,
                decoration: const InputDecoration(labelText: '시·군·구'),
                items: [
                  DropdownMenuItem<String?>(value: null, child: Text('$_sido 전체')),
                  for (final r in sigungu) DropdownMenuItem<String?>(value: r.id, child: Text(r.sigungu.isEmpty ? r.name : r.sigungu)),
                ],
                onChanged: (v) => _changed(() => _regionId = v),
              ),
            ],
            label('성별'),
            SegmentedButton<String>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: 'all', label: Text('전체')),
                ButtonSegment(value: 'female', label: Text('여자')),
                ButtonSegment(value: 'male', label: Text('남자')),
              ],
              selected: {_gender},
              onSelectionChanged: (s) => _changed(() => _gender = s.first),
            ),
            if (_gender != 'all')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('성별을 공개한 회원에게만 보내요.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
            label('보낼 인원'),
            Wrap(
              spacing: 8,
              children: [
                for (final c in _counts) ChoiceChip(label: Text('$c명'), selected: _count == c, onSelected: (_) => _changed(() => _count = c)),
              ],
            ),
            label('쪽지 내용'),
            TextField(
              controller: _text,
              maxLength: 100,
              minLines: 3,
              maxLines: 5,
              decoration: const InputDecoration(hintText: '예: 안녕하세요! 근처에 사는데 같이 산책할 친구 찾아요 (링크는 넣을 수 없어요)'),
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: _loading && p == null
                    ? const Center(child: CircularProgressIndicator())
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(n == 0 ? '지금 조건에 보낼 수 있는 회원이 없어요' : '받는 사람 $n명${n < _count ? ' (조건에 맞는 회원이 $_count명보다 적어요)' : ''}', style: t.textTheme.titleMedium),
                          if (p != null && n > 0) ...[
                            const SizedBox(height: 4),
                            Text(
                              '${comma(p['cost'] as num)}P · 1명당 ${p['unitPrice']}P${((p['vipDiscountPercent'] as num?) ?? 0) > 0 ? ' (VIP 할인)' : ''} · 보유 ${comma(p['balance'] as num)}P',
                              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                            ),
                          ],
                          const SizedBox(height: 6),
                          Text('수신 거부·차단·이미 대화 중이거나 최근 거절한 회원은 빠져요.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        ],
                      ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              onPressed: _sending || _loading || n == 0 ? null : _send,
              icon: const Icon(Icons.send_outlined),
              label: Text(p == null || n == 0 ? '보내기' : p['enough'] == true ? '$n명에게 보내기 (${comma(p['cost'] as num)}P)' : '포인트 충전하고 보내기'),
            ),
          ],
        ),
      ),
    );
  }
}
