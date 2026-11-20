import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:share_plus/share_plus.dart';

import '../core/api.dart';
import 'chat_page.dart';
import 'media.dart';
import 'profile_page.dart';
import 'widgets.dart';

typedef Json = Map<String, dynamic>;

/// 모임 탭: 운영자가 여는 상설 지역방과 회원이 만드는 관심사 그룹방.
class RoomsTab extends StatefulWidget {
  const RoomsTab({super.key});

  @override
  State<RoomsTab> createState() => _RoomsTabState();
}

class _RoomsTabState extends State<RoomsTab> {
  final _q = TextEditingController();
  String _view = 'region'; // region(내 지역) | all | mine
  List<Json>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final app = AppScope.read(context);
    setState(() => _error = null);
    try {
      final query = <String, String>{
        if (_view == 'mine') 'mine': 'true',
        if (_view == 'region' && _q.text.trim().isEmpty) 'regionId': app.me?.regionId ?? '',
        if (_q.text.trim().isNotEmpty) 'q': _q.text.trim(),
      };
      final res = await app.api.get('/v1/rooms', query: query);
      if (mounted) setState(() => _items = (res['items'] as List).cast<Json>());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _open(Json r) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RoomDetailPage(roomId: r['id'] as String)));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final t = Theme.of(context);
    final items = _items;
    Widget body;
    if (items == null) {
      body = _error == null
          ? const StateView.loading()
          : StateView(
              icon: Icons.cloud_off_outlined,
              title: '모임을 불러오지 못했어요',
              message: _error,
              actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))],
            );
    } else if (items.isEmpty) {
      body = StateView(
        icon: Icons.groups_outlined,
        title: _view == 'mine' ? '가입한 방이 없어요' : '조건에 맞는 방이 아직 없어요',
        message: _view == 'mine' ? '지역방에 들어가거나 관심사 방을 직접 만들어 보세요.' : '범위를 전체로 넓히거나, 관심사 방을 직접 만들어 보세요.',
        actions: [
          if (_view == 'region')
            FilledButton(
              onPressed: () {
                setState(() => _view = 'all');
                _load();
              },
              child: const Text('전체 지역 보기'),
            ),
          OutlinedButton(onPressed: _create, child: const Text('방 만들기')),
        ],
      );
    } else {
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView.separated(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final r = items[i];
            final tags = (r['tags'] as List).cast<String>();
            final full = (r['memberCount'] as num) >= (r['capacity'] as num);
            return Card(
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => _open(r),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Avatar(name: r['title'] as String, colorIndex: (r['title'] as String).length, size: 52, mediaId: r['imageMediaId'] as String?),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    r['title'] as String,
                                    style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                if (r['kind'] == 'region')
                                  Padding(
                                    padding: const EdgeInsets.only(left: 8),
                                    child: Text(
                                      '상설 지역방',
                                      style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w700),
                                    ),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(
                              [
                                if (r['regionName'] != null) r['regionName'],
                                '${r['memberCount']} / ${r['capacity']}명${full ? ' · 정원 마감' : ''}',
                                '${shortTime(DateTime.parse(r['lastActivityAt'] as String).toLocal())} 활동',
                              ].join(' · '),
                              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                            ),
                            if ((r['intro'] as String).isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(r['intro'] as String, maxLines: 2, overflow: TextOverflow.ellipsis),
                            ],
                            if (tags.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(tags.map((e) => '#$e').join('  '), style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.primary)),
                            ],
                            if (r['myRole'] != null || r['pendingRequest'] == true || r['requireApproval'] == true) ...[
                              const SizedBox(height: 6),
                              Text(
                                r['myRole'] != null
                                    ? '참여 중'
                                    : r['pendingRequest'] == true
                                    ? '가입 승인 대기 중'
                                    : '가입 승인제',
                                style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.tertiary, fontWeight: FontWeight.w700),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('모임')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _create, icon: const Icon(Icons.add), label: const Text('방 만들기')),
      body: ContentWidth(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: TextField(
                controller: _q,
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => _load(),
                decoration: InputDecoration(
                  hintText: '제목·지역·태그 검색',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _q.text.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () {
                            _q.clear();
                            _load();
                          },
                        ),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
            UnderlineTabs<String>(
              items: [('region', app.me?.regionName.split(' ').last ?? '내 지역'), ('all', '전체'), ('mine', '내 방')],
              value: _view,
              onChanged: (v) {
                setState(() => _view = v);
                _load();
              },
            ),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }

  Future<void> _create() async {
    final created = await Navigator.of(context).push(MaterialPageRoute<Json>(builder: (_) => const RoomEditPage()));
    if (created != null && mounted) {
      await AppScope.read(context).refreshInbox();
      _load();
      if (mounted) {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ChatPage(conversationId: created['id'] as String, title: created['title'] as String),
          ),
        );
      }
    }
  }
}

/// 방 만들기·설정 변경
class RoomEditPage extends StatefulWidget {
  const RoomEditPage({super.key, this.room});
  final Json? room;

  @override
  State<RoomEditPage> createState() => _RoomEditPageState();
}

class _RoomEditPageState extends State<RoomEditPage> {
  late final _title = TextEditingController(text: (widget.room?['title'] ?? '') as String);
  late final _intro = TextEditingController(text: (widget.room?['intro'] ?? '') as String);
  late final _tags = TextEditingController(text: ((widget.room?['tags'] ?? const []) as List).join(' '));
  late double _capacity = ((widget.room?['capacity'] ?? 30) as num).toDouble();
  late bool _searchable = (widget.room?['searchable'] ?? true) as bool;
  late bool _private = (widget.room?['isPrivate'] ?? false) as bool;
  late bool _approval = (widget.room?['requireApproval'] ?? false) as bool;
  late String? _regionId = widget.room?['regionId'] as String?;
  late String? _regionName = widget.room?['regionName'] as String?;
  late String? _imageId = widget.room?['imageMediaId'] as String?;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.read(context);
    app.loadCatalog().catchError((_) {});
    if (widget.room == null && _regionId == null) {
      _regionId = app.me?.regionId;
      _regionName = app.me?.regionName;
    }
  }

  Future<void> _save() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    final body = {
      'title': _title.text,
      'intro': _intro.text,
      'tags': _tags.text.split(RegExp(r'[\s,]+')).where((e) => e.isNotEmpty).toList(),
      'capacity': _capacity.round(),
      'searchable': _searchable,
      'isPrivate': _private,
      'requireApproval': _approval,
      'regionId': _regionId,
      'imageMediaId': _imageId,
    };
    try {
      final res = widget.room == null ? await app.api.post('/v1/rooms', body) : await app.api.patch('/v1/rooms/${widget.room!['id']}', body);
      if (mounted) Navigator.of(context).pop(res);
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final members = ((widget.room?['memberCount'] ?? 2) as num).toDouble();
    final maxCap = _capacity > 50 ? _capacity : 50.0;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.room == null ? '방 만들기' : '방 설정'),
        actions: [
          TextButton(onPressed: _busy ? null : _save, child: const Text('저장')),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 520,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
            children: [
              Row(
                children: [
                  Avatar(name: _title.text, colorIndex: _title.text.length, size: 64, mediaId: _imageId),
                  const SizedBox(width: 14),
                  OutlinedButton(
                    onPressed: () async {
                      final bytes = await pickPhoto(context);
                      if (bytes == null || !context.mounted) return;
                      try {
                        final id = await AppScope.read(context).uploadImage(bytes, 'room');
                        if (mounted) setState(() => _imageId = id);
                      } catch (e) {
                        if (context.mounted) showMessage(context, e.toString());
                      }
                    },
                    child: const Text('대표 이미지'),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _title,
                maxLength: 30,
                decoration: const InputDecoration(labelText: '방 제목', hintText: '예) 원주 주말 등산'),
                onChanged: (_) => setState(() {}),
              ),
              TextField(
                controller: _intro,
                maxLength: 300,
                minLines: 2,
                maxLines: 5,
                decoration: const InputDecoration(labelText: '소개'),
              ),
              TextField(
                controller: _tags,
                decoration: const InputDecoration(labelText: '해시태그', hintText: '등산 주말 초보환영 (띄어쓰기로 구분, 최대 5개)'),
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: () async {
                  final r = await pickRegion(context);
                  if (r != null) {
                    setState(() {
                      _regionId = r.id;
                      _regionName = r.name;
                    });
                  }
                },
                icon: const Icon(Icons.place_outlined),
                label: Text(_regionName ?? '활동 지역 선택'),
              ),
              const SizedBox(height: 16),
              Text('정원 ${_capacity.round()}명', style: t.textTheme.titleSmall),
              Slider(
                value: _capacity.clamp(members < 2 ? 2 : members, maxCap),
                min: members < 2 ? 2 : members,
                max: maxCap,
                divisions: (maxCap - (members < 2 ? 2 : members)).round().clamp(1, 300),
                label: '${_capacity.round()}',
                onChanged: members >= maxCap ? null : (v) => setState(() => _capacity = v),
              ),
              Text('50명까지는 무료, 그 이상은 방 정보에서 포인트로 확장할 수 있어요.', style: t.textTheme.bodySmall),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('비밀방'),
                subtitle: const Text('검색에 나오지 않고 초대 코드가 있어야 들어올 수 있습니다.'),
                value: _private,
                onChanged: (v) => setState(() => _private = v),
              ),
              if (!_private)
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('검색에 노출'),
                  value: _searchable,
                  onChanged: (v) => setState(() => _searchable = v),
                ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('가입 승인제'),
                subtitle: const Text('방장·운영진이 승인해야 들어올 수 있습니다.'),
                value: _approval,
                onChanged: (v) => setState(() => _approval = v),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 방 정보: 입장, 회원 목록, 공지, 운영(승인·강퇴·위임·정원 확장), 나가기
class RoomDetailPage extends StatefulWidget {
  const RoomDetailPage({super.key, required this.roomId});
  final String roomId;

  @override
  State<RoomDetailPage> createState() => _RoomDetailPageState();
}

class _RoomDetailPageState extends State<RoomDetailPage> {
  Json? _room;
  List<Json> _members = const [];
  List<Json> _requests = const [];
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  bool get _joined => _room?['myRole'] != null;
  bool get _owner => _room?['myRole'] == 'owner';
  bool get _staff => _owner || _room?['myRole'] == 'manager';

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    try {
      final room = await api.get('/v1/rooms/${widget.roomId}');
      var members = const <Json>[];
      var requests = const <Json>[];
      if (room['myRole'] != null) {
        members = ((await api.get('/v1/rooms/${widget.roomId}/members'))['items'] as List).cast<Json>();
        if (room['myRole'] == 'owner' || room['myRole'] == 'manager') {
          requests = ((await api.get('/v1/rooms/${widget.roomId}/requests'))['items'] as List).cast<Json>();
        }
      }
      if (mounted) {
        setState(() {
          _room = room;
          _members = members;
          _requests = requests;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _call(Future<Json> Function(ApiClient api) job, {String? done}) async {
    if (_busy) return;
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      await job(app.api);
      await app.refreshInbox();
      await _load();
      if (done != null && mounted) showMessage(context, done);
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _join() async {
    final room = _room!;
    String? code;
    if (room['isPrivate'] == true) {
      final c = TextEditingController();
      code = await showDialog<String>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('초대 코드'),
          content: TextField(
            controller: c,
            autofocus: true,
            decoration: const InputDecoration(hintText: '방장에게 받은 코드'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(d).pop(), child: const Text('취소')),
            FilledButton(onPressed: () => Navigator.of(d).pop(c.text.trim()), child: const Text('입장')),
          ],
        ),
      );
      if (code == null) return;
    }
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/rooms/${widget.roomId}/join', {'inviteCode': ?code});
      await app.refreshInbox();
      await _load();
      if (!mounted) return;
      if (res['status'] == 'requested') {
        showMessage(context, '가입을 신청했어요. 승인되면 대화 탭에 방이 나타납니다.');
      } else {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => ChatPage(conversationId: widget.roomId, title: room['title'] as String),
          ),
        );
      }
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _leave() async {
    final app = AppScope.read(context);
    Json body = {};
    if (_owner && _members.length > 1) {
      // 방장은 나가기 전에 위임 또는 종료를 고른다.
      final choice = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (sheet) => ListView(
          shrinkWrap: true,
          children: [
            const ListTile(title: Text('방장을 넘길 회원을 고르거나 방을 종료하세요')),
            for (final m in _members.where((m) => m['role'] != 'owner'))
              ListTile(
                leading: Avatar(name: m['nickname'] as String, colorIndex: (m['avatarColor'] ?? 0) as int, size: 36, mediaId: m['photoMediaId'] as String?),
                title: Text(m['nickname'] as String),
                subtitle: Text(m['role'] == 'manager' ? '운영진' : '회원'),
                trailing: const Text('위임하고 나가기'),
                onTap: () => Navigator.of(sheet).pop(m['userId'] as String),
              ),
            ListTile(
              leading: const Icon(Icons.cancel_outlined),
              title: const Text('방 종료'),
              subtitle: const Text('모든 회원이 더 이상 대화할 수 없습니다.'),
              onTap: () => Navigator.of(sheet).pop('close'),
            ),
          ],
        ),
      );
      if (choice == null) return;
      body = choice == 'close' ? {'close': true} : {'transferTo': choice};
    } else if (!await confirm(context, title: '방에서 나갈까요?', message: _owner ? '혼자 남은 방이라 나가면 방이 종료됩니다.' : '다시 들어오려면 새로 가입해야 합니다.', action: '나가기')) {
      return;
    }
    try {
      await app.api.post('/v1/rooms/${widget.roomId}/leave', body);
      await app.refreshInbox();
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  void _memberMenu(Json m) {
    final me = AppScope.read(context).me?.userId;
    if (m['userId'] == me) return;
    final id = m['userId'] as String;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) {
        void run(Future<Json> Function(ApiClient) job, String done) {
          Navigator.of(sheet).pop();
          _call(job, done: done);
        }

        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.person_outline),
                title: const Text('프로필 보기'),
                onTap: () {
                  Navigator.of(sheet).pop();
                  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProfilePage(userId: id)));
                },
              ),
              if (_owner && m['role'] == 'member')
                ListTile(
                  leading: const Icon(Icons.shield_outlined),
                  title: const Text('운영진으로 지정'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/role', {'role': 'manager'}), '운영진으로 지정했습니다.'),
                ),
              if (_owner && m['role'] == 'manager')
                ListTile(
                  leading: const Icon(Icons.shield_outlined),
                  title: const Text('운영진 해제'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/role', {'role': 'member'}), '운영진에서 해제했습니다.'),
                ),
              if (_owner)
                ListTile(
                  leading: const Icon(Icons.swap_horiz),
                  title: const Text('방장 위임'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/role', {'role': 'owner'}), '방장을 넘겼습니다.'),
                ),
              if (_staff && m['role'] != 'owner' && (_owner || m['role'] == 'member')) ...[
                ListTile(
                  leading: const Icon(Icons.logout),
                  title: const Text('내보내기'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/kick', {'banDays': 0}), '내보냈습니다.'),
                ),
                ListTile(
                  leading: const Icon(Icons.timer_outlined),
                  title: const Text('내보내고 7일간 재가입 제한'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/kick', {'banDays': 7}), '내보내고 7일간 재가입을 막았습니다.'),
                ),
                ListTile(
                  leading: const Icon(Icons.block),
                  title: const Text('내보내고 재가입 금지'),
                  onTap: () => run((a) => a.post('/v1/rooms/${widget.roomId}/members/$id/kick', {'banDays': null}), '내보내고 재가입을 막았습니다.'),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Future<void> _expand() async {
    final api = AppScope.read(context).api;
    try {
      final q = await api.get('/v1/rooms/expand-quote');
      if (!mounted) return;
      final ok = await confirm(
        context,
        title: '정원 ${q['step']}명 확장',
        message: '소모 포인트: ${comma(q['cost'] as num)}P (보유 ${comma(q['balance'] as num)}P)\n확장한 정원은 방이 유지되는 동안 계속 적용됩니다.',
        action: '확장',
      );
      if (ok) _call((a) => a.post('/v1/rooms/${widget.roomId}/expand'), done: '정원을 늘렸습니다.');
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  /// 모임을 카카오톡·문자로 공유. 내 친구 초대 코드·링크를 함께 넣어 새 회원 유입으로 이어지게 한다.
  Future<void> _shareRoom(Json r) async {
    final app = AppScope.read(context);
    String invite = '';
    try {
      final me = await app.api.get('/v1/me/invite');
      if (me['enabled'] == true) {
        invite = '\n이음톡이 처음이면 가입할 때 초대 코드 ${me['code']} 를 넣어 주세요(${me['inviteeReward']}P).\n${me['link']}';
      } else {
        invite = '\n${me['link']}';
      }
    } catch (_) {}
    final private = r['inviteCode'] != null ? '\n비밀방 초대 코드: ${r['inviteCode']}' : '';
    final text = '[이음톡] "${r['title']}" 모임에 함께해요.\n앱에서 모임 탭 → "${r['title']}"를 찾아 들어오세요.$private$invite';
    await SharePlus.instance.share(ShareParams(text: text, subject: '${r['title']} 모임 초대'));
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final r = _room;
    if (r == null) {
      return Scaffold(
        appBar: AppBar(),
        body: _error == null ? const StateView.loading() : StateView(icon: Icons.groups_outlined, title: '방을 볼 수 없어요', message: _error),
      );
    }
    final tags = (r['tags'] as List).cast<String>();
    final closed = r['closed'] == true;
    final full = (r['memberCount'] as num) >= (r['capacity'] as num);
    Widget header(String s) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
      child: Text(s, style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.primary)),
    );

    return Scaffold(
      appBar: AppBar(
        actions: [
          if (_owner)
            IconButton(
              icon: const Icon(Icons.settings_outlined),
              tooltip: '방 설정',
              onPressed: () async {
                await Navigator.of(context).push(MaterialPageRoute<Json>(builder: (_) => RoomEditPage(room: r)));
                _load();
              },
            ),
          if (r['isPrivate'] != true || r['inviteCode'] != null)
            IconButton(
              icon: const Icon(Icons.share_outlined),
              tooltip: '모임 공유',
              onPressed: () => _shareRoom(r),
            ),
          IconButton(
            icon: const Icon(Icons.flag_outlined),
            tooltip: '방 신고',
            onPressed: () => showReportSheet(context, targetType: 'room', targetId: widget.roomId),
          ),
        ],
      ),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
              child: Row(
                children: [
                  Avatar(name: r['title'] as String, colorIndex: (r['title'] as String).length, size: 72, mediaId: r['imageMediaId'] as String?),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(r['title'] as String, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                        Text(
                          [
                            r['kind'] == 'region' ? '상설 지역방' : '관심사 모임',
                            if (r['regionName'] != null) r['regionName'],
                            '${r['memberCount']} / ${r['capacity']}명',
                          ].join(' · '),
                          style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if ((r['intro'] as String).isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: Text(r['intro'] as String, style: t.textTheme.bodyLarge),
              ),
            if (tags.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                child: Text(tags.map((e) => '#$e').join('  '), style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary)),
              ),
            if (r['notice'] != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: Card(
                  child: ListTile(
                    leading: const Icon(Icons.push_pin_outlined),
                    title: Text('${r['notice']['body']}'),
                    subtitle: const Text('공지'),
                    trailing: _staff
                        ? IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: '공지 내리기',
                            onPressed: () => _call((a) => a.post('/v1/rooms/${widget.roomId}/notice', {'messageId': null})),
                          )
                        : null,
                  ),
                ),
              ),
            if (r['inviteCode'] != null)
              ListTile(
                leading: const Icon(Icons.key_outlined),
                title: Text('초대 코드 ${r['inviteCode']}'),
                trailing: TextButton(
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: '${r['inviteCode']}'));
                    showMessage(context, '초대 코드를 복사했습니다.');
                  },
                  child: const Text('복사'),
                ),
              ),
            if (_owner && r['kind'] == 'interest')
              ListTile(
                leading: const Icon(Icons.group_add_outlined),
                title: const Text('정원 확장'),
                subtitle: const Text('포인트로 10명씩 늘릴 수 있습니다.'),
                trailing: const Icon(Icons.chevron_right),
                onTap: _expand,
              ),
            if (_requests.isNotEmpty) ...[
              header('가입 신청 ${_requests.length}건'),
              for (final q in _requests)
                ListTile(
                  leading: Avatar(name: q['nickname'] as String, colorIndex: (q['avatarColor'] ?? 0) as int, size: 40),
                  title: Text('${q['nickname']} · ${q['ageBand']}'),
                  trailing: Wrap(
                    spacing: 4,
                    children: [
                      TextButton(onPressed: () => _call((a) => a.post('/v1/rooms/${widget.roomId}/requests/${q['id']}/reject')), child: const Text('거절')),
                      FilledButton.tonal(
                        onPressed: () => _call((a) => a.post('/v1/rooms/${widget.roomId}/requests/${q['id']}/approve'), done: '승인했습니다.'),
                        child: const Text('승인'),
                      ),
                    ],
                  ),
                ),
            ],
            if (_joined) ...[
              header('참여 회원 ${_members.length}명'),
              for (final m in _members)
                ListTile(
                  leading: Avatar(name: m['nickname'] as String, colorIndex: (m['avatarColor'] ?? 0) as int, size: 40, mediaId: m['photoMediaId'] as String?),
                  title: Text(m['nickname'] as String),
                  trailing: m['role'] == 'member'
                      ? null
                      : Text(m['role'] == 'owner' ? '방장' : '운영진', style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.primary)),
                  onTap: () => _memberMenu(m),
                ),
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: OutlinedButton(onPressed: _leave, child: const Text('방 나가기')),
              ),
            ],
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: SizedBox(
            height: 54,
            child: _joined
                ? FilledButton.icon(
                    onPressed: () => Navigator.of(context).pushReplacement(
                      MaterialPageRoute<void>(
                        builder: (_) => ChatPage(conversationId: widget.roomId, title: r['title'] as String),
                      ),
                    ),
                    icon: const Icon(Icons.chat_bubble_outline),
                    label: const Text('대화방 열기'),
                  )
                : FilledButton(
                    onPressed: closed || _busy || r['pendingRequest'] == true || (full && r['requireApproval'] != true) ? null : _join,
                    child: Text(
                      closed
                          ? '종료된 방입니다'
                          : r['pendingRequest'] == true
                          ? '가입 승인 대기 중'
                          : full
                          ? '정원이 가득 찼습니다'
                          : r['requireApproval'] == true
                          ? '가입 신청하기'
                          : '입장하기',
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}
