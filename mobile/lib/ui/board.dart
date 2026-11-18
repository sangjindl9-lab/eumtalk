import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import 'chat_page.dart';
import 'media.dart';
import 'points.dart';
import 'profile_page.dart';
import 'rooms.dart' show Json;
import 'widgets.dart';

const boardCategories = {'daily': '일상', 'question': '질문', 'hobby': '취미', 'meetup': '모임 모집'};
const marketCategories = {'sell': '판매', 'buy': '구매', 'free': '무료 나눔'};
const marketStatuses = {'selling': '판매 중', 'reserved': '예약 중', 'done': '거래 완료'};
const itemConditions = ['새 상품', '거의 새것', '사용감 있음', '수리 필요'];

/// 동네 탭: 게시판과 장터
class BoardTab extends StatefulWidget {
  const BoardTab({super.key});

  @override
  State<BoardTab> createState() => _BoardTabState();
}

class _BoardTabState extends State<BoardTab> {
  String _kind = 'board';
  String? _category;
  String _scope = 'region'; // region | sido | all
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
      final res = await app.api.get('/v1/posts', query: {'kind': _kind, 'category': ?_category, if (_scope != 'region') 'scope': _scope});
      if (mounted) setState(() => _items = (res['items'] as List).cast<Json>());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _write() async {
    final ok = await Navigator.of(context).push(MaterialPageRoute<bool>(builder: (_) => PostEditPage(kind: _kind)));
    if (ok == true) _load();
  }

  Future<void> _open(Json p) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PostDetailPage(postId: p['id'] as String)));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final t = Theme.of(context);
    final cats = _kind == 'board' ? boardCategories : marketCategories;
    final items = _items;
    final regionShort = app.me?.regionName.split(' ').last ?? '내 지역';

    Widget body;
    if (items == null) {
      body = _error == null
          ? const StateView.loading()
          : StateView(
              icon: Icons.cloud_off_outlined,
              title: '글을 불러오지 못했어요',
              message: _error,
              actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))],
            );
    } else if (items.isEmpty) {
      body = StateView(
        icon: _kind == 'board' ? Icons.article_outlined : Icons.storefront_outlined,
        title: _kind == 'board' ? '아직 올라온 글이 없어요' : '아직 올라온 물건이 없어요',
        message: '첫 글을 남기거나 범위를 넓혀 보세요.',
        actions: [
          if (_scope == 'region')
            FilledButton(
              onPressed: () {
                setState(() => _scope = 'sido');
                _load();
              },
              child: const Text('시·도 전체 보기'),
            ),
          OutlinedButton(onPressed: _write, child: const Text('글쓰기')),
        ],
      );
    } else {
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView.separated(
          padding: const EdgeInsets.only(bottom: 96),
          itemCount: items.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, i) => _PostTile(post: items[i], onTap: () => _open(items[i])),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('동네'),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.place_outlined),
            tooltip: '지역 범위',
            onSelected: (v) {
              setState(() => _scope = v);
              _load();
            },
            itemBuilder: (_) => [
              CheckedPopupMenuItem(value: 'region', checked: _scope == 'region', child: Text(regionShort)),
              CheckedPopupMenuItem(value: 'sido', checked: _scope == 'sido', child: const Text('시·도 전체')),
              CheckedPopupMenuItem(value: 'all', checked: _scope == 'all', child: const Text('전국')),
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _write,
        icon: const Icon(Icons.edit_outlined),
        label: Text(_kind == 'board' ? '글쓰기' : '물건 올리기'),
      ),
      body: ContentWidth(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: SizedBox(
                width: double.infinity,
                child: SegmentedButton<String>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: 'board', label: Text('게시판')),
                    ButtonSegment(value: 'market', label: Text('장터')),
                  ],
                  selected: {_kind},
                  onSelectionChanged: (s) {
                    setState(() {
                      _kind = s.first;
                      _category = null;
                      _items = null;
                    });
                    _load();
                  },
                ),
              ),
            ),
            SizedBox(
              height: 44,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: [
                  for (final e in <MapEntry<String?, String>>[const MapEntry(null, '전체'), ...cats.entries])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(e.value),
                        selected: _category == e.key,
                        onSelected: (_) {
                          setState(() => _category = e.key);
                          _load();
                        },
                      ),
                    ),
                ],
              ),
            ),
            if (_scope != 'region')
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    _scope == 'sido' ? '시·도 전체 글을 보고 있어요' : '전국 글을 보고 있어요',
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  ),
                ),
              ),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}

class _PostTile extends StatelessWidget {
  const _PostTile({required this.post, required this.onTap});
  final Json post;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final p = post;
    final market = p['kind'] == 'market';
    final media = (p['mediaIds'] as List).cast<String>();
    final cat = (market ? marketCategories : boardCategories)[p['category']] ?? '';
    final done = p['marketStatus'] == 'done';
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (market)
              Padding(
                padding: const EdgeInsets.only(right: 14),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: media.isEmpty
                      ? Container(
                          width: 84,
                          height: 84,
                          color: t.colorScheme.surfaceContainerHighest,
                          child: Icon(Icons.inventory_2_outlined, color: t.colorScheme.outline),
                        )
                      : MediaImage(mediaId: media.first, width: 84, height: 84),
                ),
              ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (p['pinned'] == true)
                        Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: Icon(Icons.push_pin, size: 14, color: t.colorScheme.tertiary),
                        ),
                      Text(
                        cat,
                        style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w700),
                      ),
                      if (market && p['marketStatus'] != 'selling')
                        Padding(
                          padding: const EdgeInsets.only(left: 8),
                          child: Text(
                            marketStatuses[p['marketStatus']] ?? '',
                            style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.tertiary, fontWeight: FontWeight.w700),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    p['title'] as String,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: t.textTheme.titleMedium?.copyWith(color: done ? t.colorScheme.outline : null),
                  ),
                  if (market && p['category'] != 'buy')
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(won((p['price'] ?? 0) as num), style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    )
                  else if (!market && (p['body'] as String).isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        p['body'] as String,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                      ),
                    ),
                  const SizedBox(height: 6),
                  Text(
                    '${p['author']['nickname']} · ${p['regionName']} · ${shortTime(DateTime.parse(p['createdAt'] as String).toLocal())}'
                    '${(p['commentCount'] as num) > 0 ? ' · 댓글 ${p['commentCount']}' : ''}${(p['likeCount'] as num) > 0 ? ' · 공감 ${p['likeCount']}' : ''}',
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            if (!market && media.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 12),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: MediaImage(mediaId: media.first, width: 64, height: 64),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 한 회원이 공개로 쓴 글 목록(프로필에서 연다)
class AuthorPostsPage extends StatefulWidget {
  const AuthorPostsPage({super.key, required this.userId, required this.nickname});
  final String userId;
  final String nickname;

  @override
  State<AuthorPostsPage> createState() => _AuthorPostsPageState();
}

class _AuthorPostsPageState extends State<AuthorPostsPage> {
  List<Json>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    try {
      final board = await api.get('/v1/posts', query: {'kind': 'board', 'authorId': widget.userId});
      final market = await api.get('/v1/posts', query: {'kind': 'market', 'authorId': widget.userId});
      final all = [...(board['items'] as List).cast<Json>(), ...(market['items'] as List).cast<Json>()]
        ..sort((a, b) => (b['createdAt'] as String).compareTo(a['createdAt'] as String));
      if (mounted) setState(() => _items = all);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      appBar: AppBar(title: Text('${widget.nickname} 님의 글')),
      body: ContentWidth(
        child: items == null
            ? (_error == null ? const StateView.loading() : StateView(icon: Icons.cloud_off_outlined, title: '불러오지 못했어요', message: _error))
            : items.isEmpty
            ? const StateView(icon: Icons.article_outlined, title: '공개한 글이 없어요')
            : ListView.separated(
                itemCount: items.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, i) => _PostTile(
                  post: items[i],
                  onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PostDetailPage(postId: items[i]['id'] as String))),
                ),
              ),
      ),
    );
  }
}

/// 글쓰기(게시판·장터 공용)
class PostEditPage extends StatefulWidget {
  const PostEditPage({super.key, required this.kind});
  final String kind;

  @override
  State<PostEditPage> createState() => _PostEditPageState();
}

class _PostEditPageState extends State<PostEditPage> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  final _price = TextEditingController();
  late String _category = widget.kind == 'board' ? 'daily' : 'sell';
  String _condition = '사용감 있음';
  String? _regionId;
  String? _regionName;
  final List<String> _media = [];
  bool _busy = false;
  bool _uploading = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.read(context);
    app.loadCatalog().catchError((_) {});
    _regionId ??= app.me?.regionId;
    _regionName ??= app.me?.regionName;
  }

  Future<void> _addPhoto() async {
    final bytes = await pickPhoto(context);
    if (bytes == null || !mounted) return;
    setState(() => _uploading = true);
    try {
      final id = await AppScope.read(context).uploadImage(bytes, 'post');
      if (mounted) setState(() => _media.add(id));
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _submit() async {
    final market = widget.kind == 'market';
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.post('/v1/posts', {
        'kind': widget.kind,
        'category': _category,
        'title': _title.text,
        'body': _body.text,
        'regionId': _regionId,
        'mediaIds': _media,
        if (market && _category != 'free') 'price': int.tryParse(_price.text.replaceAll(',', '')) ?? 0,
        if (market && _category != 'buy') 'itemCondition': _condition,
      });
      if (mounted) Navigator.of(context).pop(true);
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
    final market = widget.kind == 'market';
    final cats = market ? marketCategories : boardCategories;
    return Scaffold(
      appBar: AppBar(
        title: Text(market ? '물건 올리기' : '글쓰기'),
        actions: [
          TextButton(onPressed: _busy || _uploading ? null : _submit, child: const Text('등록')),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 560,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
            children: [
              Wrap(
                spacing: 8,
                children: [
                  for (final e in cats.entries)
                    ChoiceChip(label: Text(e.value), selected: _category == e.key, onSelected: (_) => setState(() => _category = e.key)),
                ],
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 84,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    if (_media.length < 5)
                      InkWell(
                        onTap: _uploading ? null : _addPhoto,
                        borderRadius: BorderRadius.circular(12),
                        child: Container(
                          width: 84,
                          decoration: BoxDecoration(
                            border: Border.all(color: t.colorScheme.outlineVariant),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: _uploading
                              ? const Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                              : Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    const Icon(Icons.add_a_photo_outlined),
                                    Text('${_media.length}/5', style: t.textTheme.labelSmall),
                                  ],
                                ),
                        ),
                      ),
                    for (final id in _media)
                      Padding(
                        padding: const EdgeInsets.only(left: 8),
                        child: Stack(
                          children: [
                            ClipRRect(
                              borderRadius: BorderRadius.circular(12),
                              child: MediaImage(mediaId: id, width: 84, height: 84),
                            ),
                            Positioned(
                              right: 0,
                              top: 0,
                              child: IconButton.filledTonal(
                                visualDensity: VisualDensity.compact,
                                iconSize: 16,
                                onPressed: () => setState(() => _media.remove(id)),
                                icon: const Icon(Icons.close),
                                tooltip: '사진 빼기',
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _title,
                maxLength: 60,
                decoration: InputDecoration(labelText: market ? '물건 이름' : '제목'),
              ),
              if (market && _category != 'free')
                TextField(
                  controller: _price,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(labelText: _category == 'buy' ? '희망 가격(원)' : '가격(원)'),
                ),
              if (market && _category != 'buy') ...[
                const SizedBox(height: 12),
                Text('물품 상태', style: t.textTheme.titleSmall),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final c in itemConditions) ChoiceChip(label: Text(c), selected: _condition == c, onSelected: (_) => setState(() => _condition = c)),
                  ],
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                controller: _body,
                minLines: 5,
                maxLines: 12,
                maxLength: 3000,
                decoration: InputDecoration(
                  labelText: '내용',
                  hintText: market ? '사용 기간, 하자 여부 등을 적어 주세요. 연락처는 적지 마세요.' : '동네 이웃과 나눌 이야기를 적어 주세요. 연락처는 적지 마세요.',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 8),
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
                label: Text('${market ? '희망 거래 지역' : '올릴 지역'}: ${_regionName ?? '선택'}'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class PostDetailPage extends StatefulWidget {
  const PostDetailPage({super.key, required this.postId});
  final String postId;

  @override
  State<PostDetailPage> createState() => _PostDetailPageState();
}

class _PostDetailPageState extends State<PostDetailPage> {
  Json? _post;
  String? _error;
  final _comment = TextEditingController();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final res = await AppScope.read(context).api.get('/v1/posts/${widget.postId}');
      if (mounted) setState(() => _post = res);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _run(Future<Json> Function(ApiClient api) job, {bool reload = true, String? done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final res = await job(AppScope.read(context).api);
      if (reload) {
        await _load();
      } else if (mounted && res['comments'] != null) {
        setState(() => _post = res);
      }
      if (done != null && mounted) showMessage(context, done);
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 유료 상단 고정: 결제 전에 노출 지역·기간·소모 포인트를 보여준다.
  Future<void> _pin() async {
    final api = AppScope.read(context).api;
    var days = 1;
    Json? quote;
    Future<void> load(StateSetter set) async {
      try {
        final q = await api.post('/v1/posts/${widget.postId}/pin/quote', {'days': days});
        set(() => quote = q);
      } catch (_) {
        set(() => quote = null);
      }
    }

    final ok = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, set) {
          final t = Theme.of(sheet);
          if (quote == null) load(set);
          final q = quote;
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('상단 고정', style: t.textTheme.titleLarge),
                const SizedBox(height: 12),
                SegmentedButton<int>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: 1, label: Text('1일')),
                    ButtonSegment(value: 3, label: Text('3일')),
                    ButtonSegment(value: 7, label: Text('7일')),
                  ],
                  selected: {days},
                  onSelectionChanged: (s) {
                    days = s.first;
                    set(() => quote = null);
                  },
                ),
                const SizedBox(height: 16),
                if (q == null)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else ...[
                  _kv(t, '노출 지역', '${q['regionName']} 목록 맨 위'),
                  _kv(t, '기간', '${q['days']}일 (${shortTime(DateTime.parse(q['until'] as String).toLocal())}까지)'),
                  _kv(t, '소모 포인트', '${comma(q['cost'] as num)}P'),
                  _kv(t, '보유 포인트', '${comma(q['balance'] as num)}P'),
                  const SizedBox(height: 4),
                  Text('기간이 끝나면 자동으로 일반 목록으로 돌아갑니다. 고정에 실패하면 포인트는 차감되지 않습니다.', style: t.textTheme.bodySmall),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: q['enough'] == true
                        ? FilledButton(onPressed: () => Navigator.of(sheet).pop(true), child: Text('${comma(q['cost'] as num)}P로 고정하기'))
                        : FilledButton.tonal(
                            onPressed: () {
                              Navigator.of(sheet).pop(false);
                              Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PointsPage()));
                            },
                            child: const Text('포인트가 부족해요 · 충전하러 가기'),
                          ),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
    if (ok == true) _run((a) => a.post('/v1/posts/${widget.postId}/pin', {'days': days}), done: '상단에 고정했습니다.');
  }

  static Widget _kv(ThemeData t, String k, String v) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        SizedBox(
          width: 96,
          child: Text(k, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ),
        Expanded(child: Text(v, style: t.textTheme.bodyLarge)),
      ],
    ),
  );

  Future<void> _inquire() async {
    final app = AppScope.read(context);
    final p = _post!;
    final c = TextEditingController(text: '안녕하세요, 아직 거래 가능한가요?');
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (sheet) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(sheet).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('거래 문의', style: Theme.of(sheet).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('"${p['title']}" 상품 정보와 사진이 함께 전달됩니다.', style: Theme.of(sheet).textTheme.bodySmall),
            const SizedBox(height: 12),
            TextField(controller: c, maxLength: 100, minLines: 2, maxLines: 4, autofocus: true),
            SizedBox(
              width: double.infinity,
              child: FilledButton(onPressed: () => Navigator.of(sheet).pop(c.text.trim()), child: const Text('문의 보내기')),
            ),
          ],
        ),
      ),
    );
    if (text == null || !mounted) return;
    try {
      final res = await app.api.post('/v1/posts/${widget.postId}/inquiry', {'text': text});
      await app.refreshInbox();
      if (!mounted) return;
      if (res['conversationId'] != null) {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ChatPage(conversationId: res['conversationId'] as String, title: '${p['author']['nickname']}'),
          ),
        );
      } else {
        showMessage(context, '문의를 보냈어요. 판매자가 수락하면 대화가 열립니다.');
      }
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final p = _post;
    if (p == null) {
      return Scaffold(
        appBar: AppBar(),
        body: _error == null ? const StateView.loading() : StateView(icon: Icons.article_outlined, title: '글을 볼 수 없어요', message: _error),
      );
    }
    final market = p['kind'] == 'market';
    final mine = p['mine'] == true;
    final media = (p['mediaIds'] as List).cast<String>();
    final comments = (p['comments'] as List).cast<Json>();
    final author = (p['author'] as Map).cast<String, dynamic>();

    return Scaffold(
      appBar: AppBar(
        actions: [
          IconButton(
            icon: Icon(p['bookmarked'] == true ? Icons.bookmark : Icons.bookmark_border),
            tooltip: '북마크',
            onPressed: () => _run((a) => a.post('/v1/posts/${widget.postId}/bookmark', {'on': p['bookmarked'] != true})),
          ),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'pin') _pin();
              if (v == 'report') showReportSheet(context, targetType: 'post', targetId: widget.postId);
              if (v == 'delete' && await confirm(context, title: '글을 삭제할까요?', message: '삭제한 글은 되돌릴 수 없습니다.', action: '삭제')) {
                await _run((a) => a.delete('/v1/posts/${widget.postId}'), reload: false);
                if (context.mounted) Navigator.of(context).pop();
              }
            },
            itemBuilder: (_) => [
              if (mine) const PopupMenuItem(value: 'pin', child: Text('상단 고정(포인트)')),
              if (mine) const PopupMenuItem(value: 'delete', child: Text('삭제')),
              if (!mine) const PopupMenuItem(value: 'report', child: Text('신고')),
            ],
          ),
        ],
      ),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            if (media.isNotEmpty)
              SizedBox(
                height: 260,
                child: PageView(
                  children: [
                    for (final id in media)
                      GestureDetector(
                        onTap: () => openPhoto(context, id),
                        child: MediaImage(mediaId: id),
                      ),
                  ],
                ),
              ),
            ListTile(
              contentPadding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
              leading: Avatar(
                name: author['nickname'] as String,
                colorIndex: (author['avatarColor'] ?? 0) as int,
                size: 40,
                mediaId: author['photoMediaId'] as String?,
              ),
              title: Text(author['nickname'] as String),
              subtitle: Text('${p['regionName']} · ${shortTime(DateTime.parse(p['createdAt'] as String).toLocal())}'),
              onTap: mine ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProfilePage(userId: author['userId'] as String))),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    (market ? marketCategories : boardCategories)[p['category']] ?? '',
                    style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary),
                  ),
                  const SizedBox(height: 4),
                  Text(p['title'] as String, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  if (market) ...[
                    const SizedBox(height: 6),
                    Text(
                      p['category'] == 'buy' ? '희망 ${won((p['price'] ?? 0) as num)}' : won((p['price'] ?? 0) as num),
                      style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        marketStatuses[p['marketStatus']] ?? '',
                        if (p['itemCondition'] != null) '상태: ${p['itemCondition']}',
                        '희망 거래 지역: ${p['regionName']}',
                      ].join(' · '),
                      style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                    ),
                  ],
                  if (p['pinnedUntil'] != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        '상단 고정 중 · ${shortTime(DateTime.parse(p['pinnedUntil'] as String).toLocal())}까지',
                        style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.tertiary),
                      ),
                    ),
                  const SizedBox(height: 16),
                  Text(p['body'] as String, style: t.textTheme.bodyLarge),
                  const SizedBox(height: 16),
                  if (market && mine)
                    SegmentedButton<String>(
                      showSelectedIcon: false,
                      segments: [for (final e in marketStatuses.entries) ButtonSegment(value: e.key, label: Text(e.value))],
                      selected: {p['marketStatus'] as String},
                      onSelectionChanged: (s) => _run((a) => a.patch('/v1/posts/${widget.postId}', {'marketStatus': s.first}), reload: false),
                    ),
                  Row(
                    children: [
                      TextButton.icon(
                        onPressed: () => _run((a) => a.post('/v1/posts/${widget.postId}/like', {'on': p['liked'] != true})),
                        icon: Icon(p['liked'] == true ? Icons.favorite : Icons.favorite_border, size: 18),
                        label: Text('공감 ${p['likeCount']}'),
                      ),
                      Text('댓글 ${comments.length}', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                ],
              ),
            ),
            const Divider(),
            if (comments.isEmpty)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  '첫 댓글을 남겨 보세요',
                  textAlign: TextAlign.center,
                  style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                ),
              ),
            for (final c in comments)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                leading: Avatar(name: '${c['author']['nickname']}', colorIndex: (c['author']['avatarColor'] ?? 0) as int, size: 36),
                title: Text('${c['author']['nickname']} · ${shortTime(DateTime.parse(c['createdAt'] as String).toLocal())}', style: t.textTheme.labelMedium),
                subtitle: Text(c['body'] as String, style: t.textTheme.bodyLarge),
                trailing: PopupMenuButton<String>(
                  onSelected: (v) {
                    if (v == 'delete') _run((a) => a.delete('/v1/comments/${c['id']}'));
                    if (v == 'report') showReportSheet(context, targetType: 'comment', targetId: c['id'] as String);
                  },
                  itemBuilder: (_) => [
                    if (c['mine'] == true) const PopupMenuItem(value: 'delete', child: Text('삭제')) else const PopupMenuItem(value: 'report', child: Text('신고')),
                  ],
                ),
              ),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, 6, 8, 8 + MediaQuery.of(context).viewInsets.bottom),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _comment,
                  maxLength: 500,
                  minLines: 1,
                  maxLines: 3,
                  decoration: const InputDecoration(hintText: '댓글 입력', counterText: '', contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 12)),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.send_outlined),
                tooltip: '댓글 등록',
                onPressed: _busy
                    ? null
                    : () {
                        final text = _comment.text.trim();
                        if (text.isEmpty) return;
                        _run((a) async {
                          final r = await a.post('/v1/posts/${widget.postId}/comments', {'body': text});
                          _comment.clear();
                          return r;
                        }, reload: false);
                      },
              ),
              if (market && !mine && p['marketStatus'] != 'done')
                Padding(
                  padding: const EdgeInsets.only(left: 4),
                  child: FilledButton(onPressed: _inquire, child: const Text('거래 문의')),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
