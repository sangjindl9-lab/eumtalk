import 'package:material_ui/material_ui.dart';
import 'package:geolocator/geolocator.dart';

import '../core/api.dart';
import '../core/models.dart';
import 'bulk_note.dart';
import 'monetize.dart' show BoostTag, TodayPicksStrip, VipBadge, showBoostSheet;
import 'profile_page.dart';
import 'widgets.dart';

enum _LocationNotice { none, denied, deniedForever, serviceOff, failed }

class NearbyTab extends StatefulWidget {
  const NearbyTab({super.key, required this.onFindGroups});
  final VoidCallback onFindGroups;

  @override
  State<NearbyTab> createState() => _NearbyTabState();
}

class _NearbyTabState extends State<NearbyTab> {
  List<PublicProfile> _items = [];
  bool _loading = true;
  bool _loadingMore = false;
  bool _hasMore = false;
  bool _suggestWiden = false;
  String? _error;
  String _sort = 'near';
  String _scope = 'near';
  String? _regionId;
  String? _regionName;
  final Set<String> _ageBands = {};
  String _gender = 'all';
  final Set<String> _interestIds = {};
  _LocationNotice _notice = _LocationNotice.none;
  bool _locating = false;
  bool _bannerDismissed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.read(context).loadCatalog().catchError((_) {});
      _load();
    });
  }

  Map<String, String> _query(int offset) => {
    'sort': _sort,
    'scope': _scope,
    'offset': '$offset',
    'regionId': ?_regionId,
    if (_gender != 'all') 'genders': _gender,
    if (_ageBands.isNotEmpty) 'ageBands': _ageBands.join(','),
    if (_interestIds.isNotEmpty) 'interestIds': _interestIds.join(','),
  };

  Future<void> _load() async {
    final app = AppScope.read(context);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await app.api.get('/v1/nearby', query: _query(0));
      if (!mounted) return;
      setState(() {
        _items = (res['items'] as List).map((e) => PublicProfile.fromJson(e as Map<String, dynamic>)).toList();
        _hasMore = res['hasMore'] == true;
        _suggestWiden = res['suggestWiden'] == true;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    } on NetworkException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    final app = AppScope.read(context);
    setState(() => _loadingMore = true);
    try {
      final res = await app.api.get('/v1/nearby', query: _query(_items.length));
      if (!mounted) return;
      final more = (res['items'] as List).map((e) => PublicProfile.fromJson(e as Map<String, dynamic>)).toList();
      final have = _items.map((p) => p.userId).toSet();
      setState(() {
        _items = [..._items, ...more.where((p) => !have.contains(p.userId))];
        _hasMore = res['hasMore'] == true;
      });
    } catch (_) {
      // 아래로 다시 당기면 재시도된다.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  /// '내 주변 찾기'를 처음 누를 때에만 위치 권한을 묻는다.
  Future<void> _enableLocation() async {
    if (_locating) return;
    final app = AppScope.read(context);
    setState(() => _locating = true);
    var notice = _LocationNotice.none;
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        notice = _LocationNotice.serviceOff;
      } else {
        var permission = await Geolocator.checkPermission();
        if (permission == LocationPermission.denied) {
          permission = await Geolocator.requestPermission();
        }
        if (permission == LocationPermission.denied) {
          notice = _LocationNotice.denied;
        } else if (permission == LocationPermission.deniedForever) {
          notice = _LocationNotice.deniedForever;
        } else {
          final pos = await Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 12)),
          );
          await app.api.put('/v1/me/location', {'lat': pos.latitude, 'lng': pos.longitude});
          await app.refreshMe();
        }
      }
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
      notice = _LocationNotice.failed;
    } catch (_) {
      notice = _LocationNotice.failed;
    }
    if (!mounted) return;
    setState(() {
      _locating = false;
      _notice = notice;
    });
    if (notice == _LocationNotice.none) _load();
  }

  /// 다중 인사(유료): 보내기 전에 대상 수와 포인트 비용을 보여주고, 실제 발송분만 차감된다.
  void _widen() {
    setState(() {
      _regionId = null;
      _regionName = null;
      _scope = _scope == 'near' ? 'sido' : 'all';
    });
    _load();
  }

  Future<void> _openFilters() async {
    final app = AppScope.read(context);
    final me = app.me;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheet) {
          void update(VoidCallback fn) {
            setSheet(fn);
            setState(() {});
          }

          final t = Theme.of(context);
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('찾기 조건', style: t.textTheme.titleLarge),
                const SizedBox(height: 16),
                Text('지역', style: t.textTheme.titleSmall),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    ChoiceChip(
                      label: const Text('내 주변'),
                      selected: _regionId == null && _scope == 'near',
                      onSelected: (_) => update(() {
                        _regionId = null;
                        _regionName = null;
                        _scope = 'near';
                      }),
                    ),
                    ChoiceChip(
                      label: const Text('시·도 전체'),
                      selected: _regionId == null && _scope == 'sido',
                      onSelected: (_) => update(() {
                        _regionId = null;
                        _regionName = null;
                        _scope = 'sido';
                      }),
                    ),
                    ChoiceChip(
                      label: const Text('전국'),
                      selected: _regionId == null && _scope == 'all',
                      onSelected: (_) => update(() {
                        _regionId = null;
                        _regionName = null;
                        _scope = 'all';
                      }),
                    ),
                    ActionChip(
                      avatar: const Icon(Icons.place_outlined, size: 18),
                      label: Text(_regionName ?? '시·군·구 고르기'),
                      onPressed: () async {
                        String? sido;
                        for (final r in app.regions) {
                          if (r.id == me?.regionId) sido = r.sido;
                        }
                        // 내 시·도 안에서는 자유롭게, 둘러보기 이용 중이면 그 지역도 바로 고를 수 있다.
                        final browse = app.me?.browse;
                        if (browse != null) {
                          final useBrowse = await confirm(
                            context,
                            title: '${browse['regionName']} 보기',
                            message: '둘러보기 이용 중인 지역을 볼까요? 취소하면 내 시·도 안에서 고릅니다.',
                            action: '이 지역 보기',
                          );
                          if (useBrowse) {
                            update(() {
                              _regionId = browse['regionId'] as String;
                              _regionName = browse['regionName'] as String;
                            });
                            return;
                          }
                          if (!context.mounted) return;
                        }
                        final r = await pickRegion(context, onlySido: sido);
                        if (r != null) {
                          update(() {
                            _regionId = r.id;
                            _regionName = r.name;
                          });
                        }
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text('다른 시·도 둘러보기는 준비 중입니다.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 16),
                Text('연령대', style: t.textTheme.titleSmall),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final b in app.ageBands)
                      FilterChip(
                        label: Text(b),
                        selected: _ageBands.contains(b),
                        onSelected: (on) => update(() => on ? _ageBands.add(b) : _ageBands.remove(b)),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                Text('관심사', style: t.textTheme.titleSmall),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final i in app.interests)
                      FilterChip(
                        label: Text(i.name),
                        selected: _interestIds.contains(i.id),
                        onSelected: (on) => update(() => on ? _interestIds.add(i.id) : _interestIds.remove(i.id)),
                      ),
                  ],
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    TextButton(
                      onPressed: () => update(() {
                        _ageBands.clear();
                        _interestIds.clear();
                        _regionId = null;
                        _regionName = null;
                        _scope = 'near';
                      }),
                      child: const Text('초기화'),
                    ),
                    const Spacer(),
                    FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('이 조건으로 보기')),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
    _load();
  }

  Widget? _locationBanner(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me;
    if (me == null || me.locationShared) return null;
    final t = Theme.of(context);
    final region = me.regionName;
    String title;
    String body;
    List<Widget> actions;
    switch (_notice) {
      case _LocationNotice.denied:
      case _LocationNotice.deniedForever:
        title = '위치 권한이 꺼져 있어요';
        body = '괜찮아요. 직접 고른 지역($region) 기준으로 보여드립니다.';
        actions = [
          if (_notice == _LocationNotice.deniedForever)
            TextButton(onPressed: Geolocator.openAppSettings, child: const Text('설정 열기'))
          else
            TextButton(onPressed: _enableLocation, child: const Text('다시 묻기')),
          TextButton(onPressed: () => setState(() => _bannerDismissed = true), child: const Text('닫기')),
        ];
        break;
      case _LocationNotice.serviceOff:
        title = '기기의 위치 서비스가 꺼져 있어요';
        body = '켜지 않아도 $region 기준으로 계속 이용할 수 있습니다.';
        actions = [
          TextButton(onPressed: Geolocator.openLocationSettings, child: const Text('위치 설정')),
          TextButton(onPressed: () => setState(() => _bannerDismissed = true), child: const Text('닫기')),
        ];
        break;
      case _LocationNotice.failed:
        title = '현재 위치를 확인하지 못했어요';
        body = '$region 기준으로 보여드리고 있습니다.';
        actions = [TextButton(onPressed: _enableLocation, child: const Text('다시 시도'))];
        break;
      case _LocationNotice.none:
        title = '내 주변 찾기';
        body = '위치를 허용하면 같은 동네 회원을 먼저 보여드려요. 정확한 위치와 거리는 누구에게도 표시되지 않습니다.';
        actions = [
          FilledButton.tonal(onPressed: _locating ? null : _enableLocation, child: Text(_locating ? '확인 중…' : '위치 사용하기')),
          TextButton(onPressed: () => setState(() => _bannerDismissed = true), child: Text('$region(으)로 계속')),
        ];
        break;
    }
    if (_bannerDismissed) return null;
    return Card(
      color: t.colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.onSecondaryContainer)),
            const SizedBox(height: 4),
            Text(body, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSecondaryContainer)),
            Wrap(alignment: WrapAlignment.end, children: actions),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final filterCount = _ageBands.length + _interestIds.length + (_regionId != null || _scope != 'near' ? 1 : 0);
    final banner = _locationBanner(context);

    Widget content;
    if (_loading && _items.isEmpty) {
      content = const StateView.loading();
    } else if (_error != null && _items.isEmpty) {
      content = StateView(
        icon: Icons.cloud_off_outlined,
        title: '목록을 불러오지 못했어요',
        message: _error,
        actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))],
      );
    } else if (_items.isEmpty) {
      content = StateView(
        icon: Icons.travel_explore_outlined,
        title: '조건에 맞는 회원이 아직 없어요',
        message: '탐색 범위를 넓히거나 관심사 모임에서 사람들을 만나 보세요.',
        actions: [
          if (_scope != 'all' || _regionId != null) FilledButton(onPressed: _widen, child: const Text('탐색 범위 넓히기')),
          OutlinedButton(onPressed: widget.onFindGroups, child: const Text('관심사 모임 찾기')),
        ],
      );
    } else {
      content = RefreshIndicator(
        onRefresh: _load,
        child: NotificationListener<ScrollNotification>(
          onNotification: (n) {
            if (n.metrics.pixels > n.metrics.maxScrollExtent - 400) _loadMore();
            return false;
          },
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            itemCount: _items.length + 1,
            separatorBuilder: (_, _) => const SizedBox(height: 10),
            itemBuilder: (context, i) {
              if (i < _items.length) {
                return _PersonCard(profile: _items[i], onChanged: _load);
              }
              if (_loadingMore) {
                return const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              if (_suggestWiden && _scope != 'all') {
                return Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('주변에 회원이 많지 않아요', style: t.textTheme.titleSmall),
                          const SizedBox(height: 4),
                          Text('범위를 넓히거나 관심사 모임을 찾아보세요.', style: t.textTheme.bodySmall),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            children: [
                              FilledButton.tonal(onPressed: _widen, child: const Text('탐색 범위 넓히기')),
                              TextButton(onPressed: widget.onFindGroups, child: const Text('관심사 모임 찾기')),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }
              return const SizedBox(height: 8);
            },
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('주변'),
        actions: [
          IconButton(
            onPressed: () async {
              if (await showBoostSheet(context)) _load();
            },
            icon: const Icon(Icons.rocket_launch_outlined),
            tooltip: '내 프로필 띄우기',
          ),
          IconButton(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const BulkNotePage())),
            icon: const Icon(Icons.campaign_outlined),
            tooltip: '전체 쪽지',
          ),
          Badge(
            isLabelVisible: filterCount > 0,
            label: Text('$filterCount'),
            offset: const Offset(-6, 6),
            child: IconButton(onPressed: _openFilters, icon: const Icon(Icons.tune), tooltip: '찾기 조건'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: ContentWidth(
        child: Column(
          children: [
            // 한 줄 필터: 왼쪽 성별 칩, 오른쪽 정렬 메뉴
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 8, 6),
              child: Row(
                children: [
                  for (final g in const ['all', 'female', 'male']) ...[
                    PillChip(
                      label: g == 'all' ? '전체' : g == 'female' ? '여자' : '남자',
                      icon: g == 'female' ? Icons.female : g == 'male' ? Icons.male : null,
                      color: g == 'all' ? null : genderColor(g),
                      selected: _gender == g,
                      onTap: () {
                        if (_gender == g) return;
                        setState(() => _gender = g);
                        _load();
                      },
                    ),
                    const SizedBox(width: 6),
                  ],
                  const Spacer(),
                  PopupMenuButton<String>(
                    initialValue: _sort,
                    tooltip: '정렬',
                    onSelected: (v) {
                      if (v == _sort) return;
                      setState(() => _sort = v);
                      _load();
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'near', child: Text('가까운 순')),
                      PopupMenuItem(value: 'recent', child: Text('최근 활동 순')),
                    ],
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.swap_vert, size: 18, color: t.colorScheme.onSurfaceVariant),
                          const SizedBox(width: 4),
                          Text(_sort == 'near' ? '가까운 순' : '최근 활동 순', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                          Icon(Icons.arrow_drop_down, color: t.colorScheme.onSurfaceVariant),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (banner != null) Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: banner),
            const TodayPicksStrip(),
            Expanded(child: content),
          ],
        ),
      ),
    );
  }
}

class _PersonCard extends StatelessWidget {
  const _PersonCard({required this.profile, required this.onChanged});
  final PublicProfile profile;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final p = profile;
    final meta = p.ageBand;
    final place = [p.proximityLabel, if (p.proximity != 'far' && p.proximity != 'same_region') p.regionName].join(' · ');
    return Card(
      clipBehavior: Clip.antiAlias,
      shape: p.boosted ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: t.colorScheme.primary, width: 1.5)) : null,
      child: InkWell(
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => ProfilePage(userId: p.userId, preview: p),
            ),
          );
          onChanged();
        },
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Avatar(name: p.nickname, colorIndex: p.avatarColor, size: 56, mediaId: p.photoMediaId),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 8,
                      children: [
                        Text(p.nickname, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                        GenderMark(p.gender),
                        if (p.vip) const VipBadge(),
                        Text(meta, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        if (p.boosted) const BoostTag(),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Wrap(
                      spacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Icon(Icons.place_outlined, size: 15, color: t.colorScheme.primary),
                        Text(
                          place,
                          style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w600),
                        ),
                        if (p.activityLabel != null)
                          Text('· ${p.activityLabel}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                      ],
                    ),
                    if (p.interests.isNotEmpty) ...[const SizedBox(height: 8), InterestTags(interests: p.interests, common: p.commonInterests, max: 5)],
                    if (p.bio.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text(p.bio, maxLines: 2, overflow: TextOverflow.ellipsis, style: t.textTheme.bodyMedium),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 관심사 태그. 나와 겹치는 관심사는 채워진 색으로 강조한다.
class InterestTags extends StatelessWidget {
  const InterestTags({super.key, required this.interests, required this.common, this.max});
  final List<String> interests;
  final List<String> common;
  final int? max;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final ordered = [...common, ...interests.where((i) => !common.contains(i))];
    final shown = max == null ? ordered : ordered.take(max!).toList();
    final rest = ordered.length - shown.length;
    Widget tag(String text, bool highlight) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: highlight ? t.colorScheme.primaryContainer : Colors.transparent,
        border: Border.all(color: highlight ? Colors.transparent : t.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, style: t.textTheme.labelMedium?.copyWith(color: highlight ? t.colorScheme.onPrimaryContainer : t.colorScheme.onSurfaceVariant)),
    );
    return Wrap(spacing: 6, runSpacing: 6, children: [for (final i in shown) tag(i, common.contains(i)), if (rest > 0) tag('+$rest', false)]);
  }
}
