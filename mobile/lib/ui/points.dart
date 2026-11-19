import 'dart:async';
import 'dart:io';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import 'rooms.dart' show Json;
import 'widgets.dart';

/// 포인트·프리미엄: 잔액, 충전(스토어 결제), 구독, 사용 내역
class PointsPage extends StatefulWidget {
  const PointsPage({super.key});

  @override
  State<PointsPage> createState() => _PointsPageState();
}

class _PointsPageState extends State<PointsPage> {
  Json? _overview;
  List<Json> _ledger = const [];
  String? _error;
  Map<String, ProductDetails> _store = const {};
  bool _storeChecked = false;
  bool _storeAvailable = false;
  StreamSubscription<List<PurchaseDetails>>? _sub;
  String? _buying;

  @override
  void initState() {
    super.initState();
    // 구매 완료·복원 이벤트를 받는다. 결제 직후 앱이 꺼졌다 켜져도 스토어가 같은 이벤트를 다시 보내 준다.
    _sub = InAppPurchase.instance.purchaseStream.listen(_onPurchases, onError: (Object _) {});
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    try {
      final o = await api.get('/v1/points');
      final l = await api.get('/v1/points/ledger');
      if (!mounted) return;
      setState(() {
        _overview = o;
        _ledger = (l['items'] as List).cast<Json>();
        _error = null;
      });
      if (!_storeChecked) _loadStore((o['products'] as List).cast<Json>().map((p) => p['id'] as String).toSet());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  /// 가격과 결제 주기는 스토어 상품 정보를 읽어서 그대로 보여준다(앱에 가격을 적어 두지 않는다).
  Future<void> _loadStore(Set<String> ids) async {
    try {
      final available = await InAppPurchase.instance.isAvailable();
      var map = <String, ProductDetails>{};
      if (available) {
        final res = await InAppPurchase.instance.queryProductDetails(ids);
        map = {for (final p in res.productDetails) p.id: p};
      }
      if (mounted) {
        setState(() {
          _storeChecked = true;
          _storeAvailable = available;
          _store = map;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _storeChecked = true);
    }
  }

  Future<void> _onPurchases(List<PurchaseDetails> list) async {
    final app = AppScope.read(context);
    for (final p in list) {
      if (p.status == PurchaseStatus.pending) continue;
      if (p.status == PurchaseStatus.error || p.status == PurchaseStatus.canceled) {
        if (p.pendingCompletePurchase) await InAppPurchase.instance.completePurchase(p);
        if (mounted) {
          setState(() => _buying = null);
          if (p.status == PurchaseStatus.error) showMessage(context, '결제를 완료하지 못했어요.');
        }
        continue;
      }
      // purchased / restored: 서버가 스토어에 확인한 뒤에만 지급한다. 같은 영수증은 서버에서 한 번만 처리된다.
      try {
        final token = Platform.isIOS ? (p.purchaseID ?? '') : p.verificationData.serverVerificationData;
        final res = await app.api.post('/v1/purchases/verify', {'store': Platform.isIOS ? 'apple' : 'google', 'productId': p.productID, 'token': token});
        if (p.pendingCompletePurchase) await InAppPurchase.instance.completePurchase(p);
        if (mounted) {
          final granted = (res['granted'] ?? 0) as num;
          showMessage(context, granted > 0 ? '${comma(granted)}P가 지급되었습니다.' : (p.status == PurchaseStatus.restored ? '구매 내역을 복원했습니다.' : '이미 처리된 구매입니다.'));
        }
      } on ApiException catch (e) {
        // 검증 실패 시 완료 처리하지 않는다 → 스토어가 다음 실행 때 다시 알려 주어 재시도된다.
        if (mounted) showMessage(context, e.message);
      } on NetworkException {
        if (mounted) showMessage(context, '연결이 불안정해 지급을 확인하지 못했어요. 연결되면 자동으로 다시 확인합니다.');
      }
      if (mounted) setState(() => _buying = null);
      await _load();
    }
  }

  Future<void> _buy(Json product) async {
    final details = _store[product['id']];
    if (details == null) {
      showMessage(context, '스토어에 아직 등록되지 않은 상품입니다.');
      return;
    }
    setState(() => _buying = details.id);
    try {
      final param = PurchaseParam(productDetails: details, applicationUserName: AppScope.read(context).me?.userId);
      if (product['kind'] == 'subscription') {
        await InAppPurchase.instance.buyNonConsumable(purchaseParam: param);
      } else {
        await InAppPurchase.instance.buyConsumable(purchaseParam: param);
      }
    } catch (_) {
      if (mounted) {
        setState(() => _buying = null);
        showMessage(context, '결제 화면을 열지 못했어요.');
      }
    }
  }

  static const _typeLabel = {'charge': '충전', 'spend': '사용', 'refund': '환불', 'admin': '관리자 조정', 'grant': '지급'};

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final o = _overview;
    if (o == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('포인트')),
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
    final products = (o['products'] as List).cast<Json>();
    final prices = (o['prices'] as List).cast<Json>();
    final sub = (o['subscription'] as Map?)?.cast<String, dynamic>();
    Widget header(String s) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
      child: Text(s, style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.primary)),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('포인트')),
      body: ContentWidth(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('보유 포인트', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        Text('${comma(o['balance'] as num)}P', style: t.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w700)),
                        if (sub != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            sub['status'] == 'active'
                                ? 'VIP 이용 중 · ${shortTime(DateTime.parse(sub['expiresAt'] as String).toLocal())}${sub['autoRenew'] == true ? ' 갱신 예정' : '까지'}'
                                : sub['status'] == 'refunded'
                                ? 'VIP 환불됨'
                                : 'VIP 만료됨',
                            style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.primary),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              header('충전·VIP'),
              if (_storeChecked && !_storeAvailable)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Text('이 기기에서는 스토어 결제를 사용할 수 없습니다.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
                ),
              for (final p in products)
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  title: Text(_store[p['id']]?.title.isNotEmpty == true ? _store[p['id']]!.title : p['title'] as String),
                  subtitle: Text(p['kind'] == 'subscription' ? '매달 ${comma(p['points'] as num)}P 지급 · 유료 기능 할인 · VIP 배지 · 나를 본 사람·다른 지역 둘러보기 무료' : '${comma(p['points'] as num)}P 지급'),
                  trailing: FilledButton.tonal(
                    onPressed: _buying != null || _store[p['id']] == null ? null : () => _buy(p),
                    child: _buying == p['id']
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(_store[p['id']]?.price ?? (_storeChecked ? '준비 중' : '확인 중')),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(onPressed: _storeAvailable ? () => InAppPurchase.instance.restorePurchases() : null, child: const Text('구매 내역 복원')),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Text('구독 해지와 환불은 스토어(Google Play·App Store)에서 진행합니다.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
              header('포인트로 할 수 있는 것'),
              for (final f in prices)
                ListTile(
                  dense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  title: Text(f['label'] as String),
                  subtitle: (f['freePerDay'] as num) > 0 ? Text('하루 ${f['freePerDay']}회 무료') : null,
                  trailing: Text('${comma(f['points'] as num)}P / ${f['unit']}', style: t.textTheme.bodyMedium),
                ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Text('기본 1대1 대화와 신고·차단은 언제나 무료입니다.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ),
              header('내역'),
              if (_ledger.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    '아직 내역이 없어요',
                    textAlign: TextAlign.center,
                    style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  ),
                ),
              for (final l in _ledger)
                ListTile(
                  dense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  title: Text(l['reason'] as String),
                  subtitle: Text(
                    '${_typeLabel[l['type']] ?? l['type']} · ${shortTime(DateTime.parse(l['createdAt'] as String).toLocal())} · 잔액 ${comma(l['balanceAfter'] as num)}P',
                  ),
                  trailing: Text(
                    '${(l['delta'] as num) > 0 ? '+' : ''}${comma(l['delta'] as num)}P',
                    style: t.textTheme.titleSmall?.copyWith(
                      color: (l['delta'] as num) > 0 ? t.colorScheme.primary : t.colorScheme.onSurface,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
