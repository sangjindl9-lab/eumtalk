import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/brand.dart';
import 'profile_form.dart';
import 'widgets.dart';

class MeTab extends StatelessWidget {
  const MeTab({super.key});

  Future<void> _setting(BuildContext context, String key, bool value) async {
    try {
      await AppScope.read(context).updateMe({
        'settings': {key: value},
      });
    } catch (e) {
      if (context.mounted) showMessage(context, e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me;
    final t = Theme.of(context);
    if (me == null) return const Scaffold(body: StateView.loading());

    void open(Widget page) =>
        Navigator.of(context)
            .push(MaterialPageRoute<void>(builder: (_) => page));
    Widget header(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 4),
      child: Text(
        text,
        style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.primary),
      ),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('내 정보')),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      Avatar(
                        name: me.nickname,
                        colorIndex: me.avatarColor,
                        size: 64,
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              me.nickname,
                              style: t.textTheme.titleLarge?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              '${me.ageBand} · ${me.regionName}',
                              style: t.textTheme.bodyMedium?.copyWith(
                                color: t.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                      FilledButton.tonal(
                        onPressed: () => open(const EditProfilePage()),
                        child: const Text('수정'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            header('공개 범위'),
            SwitchListTile(
              title: const Text('주변에 나 표시'),
              subtitle: const Text('끄면 다른 회원의 주변 목록에 나타나지 않습니다.'),
              value: me.showInNearby,
              onChanged: (v) => _setting(context, 'showInNearby', v),
            ),
            SwitchListTile(
              title: const Text('최근 활동 표시'),
              subtitle: const Text('"오늘 활동" 같은 표시를 다른 회원에게 보여줍니다.'),
              value: me.showLastActive,
              onChanged: (v) => _setting(context, 'showLastActive', v),
            ),
            SwitchListTile(
              title: const Text('새 인사 받기'),
              subtitle: const Text('끄면 새로운 인사 요청이 오지 않습니다.'),
              value: me.acceptGreetings,
              onChanged: (v) => _setting(context, 'acceptGreetings', v),
            ),
            ListTile(
              title: const Text('내 주변 찾기(위치)'),
              subtitle: Text(
                me.locationShared
                    ? '사용 중 · 대략적인 위치만 서버에 저장됩니다.'
                    : '꺼짐 · ${me.regionName} 기준으로 보여드립니다. 주변 탭에서 켤 수 있어요.',
              ),
              trailing: me.locationShared
                  ? TextButton(
                      onPressed: () async {
                        try {
                          await app.api.delete('/v1/me/location');
                          await app.refreshMe();
                        } catch (e) {
                          if (context.mounted) {
                            showMessage(context, e.toString());
                          }
                        }
                      },
                      child: const Text('끄고 삭제'),
                    )
                  : null,
            ),
            header('안전'),
            ListTile(
              leading: const Icon(Icons.block_outlined),
              title: const Text('차단 목록'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => open(const BlockListPage()),
            ),
            header('안내'),
            ListTile(
              leading: const Icon(Icons.business_outlined),
              title: const Text('운영자 정보·연락처'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => open(const InfoPage(kind: InfoKind.operator)),
            ),
            ListTile(
              leading: const Icon(Icons.rule_outlined),
              title: const Text('이용규칙'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => open(const InfoPage(kind: InfoKind.rules)),
            ),
            ListTile(
              leading: const Icon(Icons.privacy_tip_outlined),
              title: const Text('개인정보 처리 안내'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => open(const InfoPage(kind: InfoKind.privacy)),
            ),
            header('계정'),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('로그아웃'),
              onTap: () async {
                if (await confirm(
                  context,
                  title: '로그아웃할까요?',
                  message: '보내지 못한 메시지와 작성 중인 내용은 이 기기에서 지워집니다.',
                  action: '로그아웃',
                )) {
                  await app.logout();
                }
              },
            ),
            const ListTile(
              enabled: false,
              leading: Icon(Icons.person_remove_outlined),
              title: Text('계정 삭제 신청'),
              subtitle: Text('신고·관리자 단계에서 함께 제공됩니다.'),
            ),
            if (AppState.allowServerOverride)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: Text(
                  '시험 서버: ${app.baseUrl}',
                  style: t.textTheme.bodySmall?.copyWith(
                    color: t.colorScheme.outline,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class EditProfilePage extends StatefulWidget {
  const EditProfilePage({super.key});

  @override
  State<EditProfilePage> createState() => _EditProfilePageState();
}

class _EditProfilePageState extends State<EditProfilePage> {
  ProfileFormData? _form;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.read(context);
    _form ??= ProfileFormData.fromMe(app.me!);
    app.loadCatalog().catchError((_) {});
  }

  Future<void> _save() async {
    final form = _form!;
    final problem = form.validate();
    if (problem != null) {
      showMessage(context, problem);
      return;
    }
    setState(() => _busy = true);
    try {
      await AppScope.read(context).updateMe(form.toJson());
      if (mounted) Navigator.of(context).pop();
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
    final app = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('프로필 수정'),
        actions: [
          TextButton(onPressed: _busy ? null : _save, child: const Text('저장')),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 520,
          child: app.interests.isEmpty
              ? const StateView.loading()
              : ListView(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
                  children: [
                    ProfileForm(data: _form!, onChanged: () => setState(() {})),
                  ],
                ),
        ),
      ),
    );
  }
}

class BlockListPage extends StatefulWidget {
  const BlockListPage({super.key});

  @override
  State<BlockListPage> createState() => _BlockListPageState();
}

class _BlockListPageState extends State<BlockListPage> {
  List<Map<String, dynamic>>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final res = await AppScope.read(context).api.get('/v1/blocks');
      if (mounted) {
        setState(() {
          _items = (res['items'] as List).cast<Map<String, dynamic>>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _unblock(String userId) async {
    final app = AppScope.read(context);
    try {
      await app.api.delete('/v1/blocks/$userId');
      await app.refreshInbox();
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    Widget body;
    if (items == null) {
      body = _error == null
          ? const StateView.loading()
          : StateView(
              icon: Icons.cloud_off_outlined,
              title: '불러오지 못했어요',
              message: _error,
              actions: [
                FilledButton(onPressed: _load, child: const Text('다시 시도')),
              ],
            );
    } else if (items.isEmpty) {
      body = const StateView(icon: Icons.block_outlined, title: '차단한 회원이 없어요');
    } else {
      body = ListView(
        children: [
          for (final b in items)
            ListTile(
              leading: Avatar(
                name: (b['nickname'] ?? '') as String,
                colorIndex: (b['avatarColor'] ?? 0) as int,
              ),
              title: Text((b['nickname'] ?? '') as String),
              trailing: OutlinedButton(
                onPressed: () => _unblock(b['userId'] as String),
                child: const Text('해제'),
              ),
            ),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('차단 목록')),
      body: ContentWidth(child: body),
    );
  }
}

enum InfoKind { operator, rules, privacy }

/// 운영자 연락처·이용규칙·개인정보 처리 안내. 문구는 출시 전 법무 검토를 거쳐 교체한다.
class InfoPage extends StatelessWidget {
  const InfoPage({super.key, required this.kind});
  final InfoKind kind;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final op = Brand.instance.operator;
    String title;
    List<(String, String)> rows;
    switch (kind) {
      case InfoKind.operator:
        title = '운영자 정보·연락처';
        rows = [
          ('상호', '${op['company'] ?? ''}'),
          ('대표자', '${op['representative'] ?? ''}'),
          ('사업자등록번호', '${op['businessNumber'] ?? ''}'),
          ('주소', '${op['address'] ?? ''}'),
          ('이메일', '${op['email'] ?? ''}'),
          ('전화', '${op['phone'] ?? ''}'),
        ];
        break;
      case InfoKind.rules:
        title = '이용규칙';
        rows = const [
          ('성인 전용', '휴대폰 인증과 성인 확인을 마친 회원만 이용할 수 있습니다.'),
          ('금지 행위', '성적 접근·거래 유도, 사기, 욕설·괴롭힘, 스팸·광고, 사칭, 타인의 개인정보 노출은 금지됩니다.'),
          (
            '인사와 대화',
            '인사는 한 사람에게 한 번 보낼 수 있고, 상대가 수락해야 대화가 열립니다. 수락 전에는 사진과 링크를 보낼 수 없습니다.',
          ),
          ('신고와 차단', '프로필·인사·메시지를 바로 신고할 수 있고, 차단하면 즉시 서로 보이지 않습니다.'),
          ('조치', '규칙을 어기면 경고, 콘텐츠 숨김, 이용 정지 조치를 받을 수 있습니다.'),
        ];
        break;
      case InfoKind.privacy:
        title = '개인정보 처리 안내';
        rows = const [
          ('공개되지 않는 정보', '휴대폰 번호, 실명, 생년월일은 다른 회원에게 표시되지 않습니다.'),
          (
            '위치',
            '"내 주변 찾기"를 켠 경우에만 대략적인 위치(약 500m 단위)를 저장하며, 좌표와 정확한 거리는 누구에게도 제공하지 않습니다. 언제든 끄고 삭제할 수 있습니다.',
          ),
          (
            '대화 내용',
            '운영자는 개인 대화를 임의로 열람하지 않습니다. 신고가 접수된 경우 해당 신고의 증거만 담당자가 확인하며 열람 기록이 남습니다.',
          ),
          ('보관과 삭제', '계정 삭제 절차와 항목별 보존 기간은 정식 출시 전 확정해 이 화면에 안내합니다.'),
        ];
        break;
    }
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            for (final (label, value) in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: t.textTheme.titleSmall),
                    const SizedBox(height: 4),
                    Text(value, style: t.textTheme.bodyMedium),
                  ],
                ),
              ),
            if (kind != InfoKind.operator)
              Text(
                '시험 버전용 초안입니다. 정식 출시 전 법무 검토를 거친 전문으로 교체됩니다.',
                style: t.textTheme.bodySmall?.copyWith(
                  color: t.colorScheme.outline,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
