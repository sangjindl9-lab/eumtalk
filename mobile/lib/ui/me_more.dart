import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import 'rooms.dart' show Json;
import 'widgets.dart';

/// 목록을 불러와 보여주는 단순 화면의 공통 틀
class _Loader extends StatefulWidget {
  const _Loader({
    required this.title,
    required this.path,
    required this.emptyTitle,
    required this.itemBuilder,
    this.emptyIcon = Icons.inbox_outlined,
    this.fab,
  });
  final String title;
  final String path;
  final String emptyTitle;
  final IconData emptyIcon;
  final Widget Function(BuildContext context, Json item, VoidCallback reload) itemBuilder;
  final Widget Function(VoidCallback reload)? fab;

  @override
  State<_Loader> createState() => _LoaderState();
}

class _LoaderState extends State<_Loader> {
  List<Json>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final res = await AppScope.read(context).api.get(widget.path);
      if (mounted) {
        setState(() {
          _items = (res['items'] as List).cast<Json>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
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
              actions: [FilledButton(onPressed: _load, child: const Text('다시 시도'))],
            );
    } else if (items.isEmpty) {
      body = StateView(icon: widget.emptyIcon, title: widget.emptyTitle);
    } else {
      body = ListView(padding: const EdgeInsets.only(bottom: 96), children: [for (final i in items) widget.itemBuilder(context, i, _load)]);
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      floatingActionButton: widget.fab?.call(_load),
      body: ContentWidth(child: body),
    );
  }
}

String _when(Json j, [String key = 'createdAt']) => shortTime(DateTime.parse(j[key] as String).toLocal());

/// 처리 결과 통지(신고 결과, 운영 조치, 문의 답변 등)
class NoticesPage extends StatelessWidget {
  const NoticesPage({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return _Loader(
      title: '알림',
      path: '/v1/notices',
      emptyTitle: '받은 알림이 없어요',
      emptyIcon: Icons.notifications_none,
      itemBuilder: (context, n, _) => ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
        leading: Icon(
          n['kind'] == 'sanction' ? Icons.gavel_outlined : Icons.notifications_none,
          color: n['unread'] == true ? t.colorScheme.primary : t.colorScheme.outline,
        ),
        title: Text(n['title'] as String, style: TextStyle(fontWeight: n['unread'] == true ? FontWeight.w700 : FontWeight.w500)),
        subtitle: Text('${n['body']}\n${_when(n)}'),
        isThreeLine: true,
        onTap: n['kind'] == 'sanction' ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SanctionsPage())) : null,
      ),
    );
  }
}

class AnnouncementsPage extends StatelessWidget {
  const AnnouncementsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Loader(
      title: '운영 공지',
      path: '/v1/announcements',
      emptyTitle: '등록된 공지가 없어요',
      emptyIcon: Icons.campaign_outlined,
      itemBuilder: (context, a, _) => ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 20),
        childrenPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        expandedAlignment: Alignment.centerLeft,
        title: Text(a['title'] as String),
        subtitle: Text(_when(a)),
        children: [Text(a['body'] as String)],
      ),
    );
  }
}

Future<String?> _askText(BuildContext context, {required String title, required String hint, required String action}) {
  final c = TextEditingController();
  return showModalBottomSheet<String>(
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
          Text(title, style: Theme.of(sheet).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(
            controller: c,
            autofocus: true,
            minLines: 4,
            maxLines: 8,
            maxLength: 1000,
            decoration: InputDecoration(hintText: hint),
          ),
          SizedBox(
            width: double.infinity,
            child: FilledButton(onPressed: () => Navigator.of(sheet).pop(c.text.trim()), child: Text(action)),
          ),
        ],
      ),
    ),
  );
}

class InquiriesPage extends StatelessWidget {
  const InquiriesPage({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return _Loader(
      title: '문의',
      path: '/v1/inquiries',
      emptyTitle: '보낸 문의가 없어요',
      emptyIcon: Icons.support_agent_outlined,
      fab: (reload) => FloatingActionButton.extended(
        icon: const Icon(Icons.edit_outlined),
        label: const Text('문의하기'),
        onPressed: () async {
          final text = await _askText(context, title: '문의하기', hint: '불편한 점이나 궁금한 점을 적어 주세요.', action: '보내기');
          if (text == null || text.isEmpty || !context.mounted) return;
          try {
            await AppScope.read(context).api.post('/v1/inquiries', {'body': text});
            reload();
          } catch (e) {
            if (context.mounted) showMessage(context, e.toString());
          }
        },
      ),
      itemBuilder: (context, q, _) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${_when(q)} · ${q['status'] == 'answered' ? '답변 완료' : '확인 중'}',
              style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 4),
            Text(q['body'] as String, style: t.textTheme.bodyLarge),
            if (q['answer'] != null)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: t.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
                child: Text('${q['answer']}'),
              ),
            const Divider(height: 24),
          ],
        ),
      ),
    );
  }
}

/// 내가 받은 운영 조치와 이의신청
class SanctionsPage extends StatelessWidget {
  const SanctionsPage({super.key});

  static const _types = {'warning': '경고', 'content_hidden': '콘텐츠 숨김', 'suspension': '이용 정지'};

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return _Loader(
      title: '조치 내역',
      path: '/v1/sanctions',
      emptyTitle: '받은 조치가 없어요',
      emptyIcon: Icons.verified_user_outlined,
      itemBuilder: (context, s, reload) {
        final appeal = (s['appeal'] as Map?)?.cast<String, dynamic>();
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${_types[s['type']] ?? s['type']}${s['until'] != null ? ' · ${_when(s, 'until')}까지' : ''}${s['lifted'] == true ? ' · 해제됨' : ''}',
                style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              Text(_when(s), style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              const SizedBox(height: 6),
              Text('사유: ${s['reason']}'),
              const SizedBox(height: 8),
              if (appeal == null)
                OutlinedButton(
                  onPressed: () async {
                    final text = await _askText(context, title: '이의신청', hint: '조치가 잘못되었다고 생각하는 이유를 적어 주세요.', action: '이의신청 보내기');
                    if (text == null || text.isEmpty || !context.mounted) return;
                    try {
                      await AppScope.read(context).api.post('/v1/appeals', {'sanctionId': s['id'], 'body': text});
                      reload();
                    } on ApiException catch (e) {
                      if (context.mounted) showMessage(context, e.message);
                    } on NetworkException catch (e) {
                      if (context.mounted) showMessage(context, e.toString());
                    }
                  },
                  child: const Text('이의신청'),
                )
              else
                Text(
                  appeal['status'] == 'pending' ? '이의신청 검토 중' : '이의신청 ${appeal['status'] == 'accepted' ? '받아들여짐' : '기각'}: ${appeal['answer'] ?? ''}',
                  style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.primary),
                ),
              const Divider(height: 24),
            ],
          ),
        );
      },
    );
  }
}

/// 계정 삭제 신청: 무엇이 지워지고 무엇이 보존되는지 먼저 보여준다.
class DeleteAccountPage extends StatefulWidget {
  const DeleteAccountPage({super.key});

  @override
  State<DeleteAccountPage> createState() => _DeleteAccountPageState();
}

class _DeleteAccountPageState extends State<DeleteAccountPage> {
  final _confirm = TextEditingController();
  final _reason = TextEditingController();
  bool _busy = false;

  Future<void> _delete() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      await app.api.delete('/v1/me', {'confirm': _confirm.text.trim(), 'reason': _reason.text.trim()});
      await app.logout(remote: false);
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
    Widget block(String title, List<String> lines) => Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: t.textTheme.titleSmall),
          const SizedBox(height: 4),
          for (final l in lines)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text('· $l', style: t.textTheme.bodyMedium),
            ),
        ],
      ),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('계정 삭제')),
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 560,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
            children: [
              block('바로 삭제되는 것', ['프로필 내용·관심사·위치', '프로필·게시글·방 사진', '푸시 알림 수신 정보와 로그인 상태', '휴대폰 번호·출생 연도', '차단 목록·북마크·공감']),
              block('더 이상 보이지 않는 것', ['주변 목록과 검색에서 내 프로필', '내가 쓴 게시글·댓글', '내가 방장인 그룹방은 운영진·회원에게 넘기거나 종료']),
              block('보존되는 것', ['신고·운영 조치 기록', '포인트·구매 내역(분쟁 대응과 법정 보존)', '상대방 대화방에 남은 메시지(보낸 사람은 "탈퇴한 회원"으로 표시)']),
              Text('남은 포인트는 사라지며, 구독은 스토어에서 따로 해지해야 합니다.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
              const SizedBox(height: 16),
              TextField(
                controller: _reason,
                maxLength: 300,
                decoration: const InputDecoration(labelText: '떠나는 이유(선택)'),
              ),
              TextField(
                controller: _confirm,
                decoration: const InputDecoration(labelText: '확인을 위해 "삭제"라고 입력해 주세요'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 16),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: t.colorScheme.error,
                  foregroundColor: t.colorScheme.onError,
                  minimumSize: const Size.fromHeight(52),
                ),
                onPressed: _busy || _confirm.text.trim() != '삭제' ? null : _delete,
                child: const Text('계정 삭제'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 이용 정지 중 화면: 조치 내용 확인, 이의신청, 문의, 로그아웃만 할 수 있다.
class SuspendedPage extends StatelessWidget {
  const SuspendedPage({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    void open(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
    return Scaffold(
      body: SafeArea(
        child: StateView(
          icon: Icons.gavel_outlined,
          title: '이용이 정지된 계정입니다',
          message: '조치 내역에서 사유를 확인하고 이의신청할 수 있습니다. 정지 기간이 끝나면 자동으로 풀립니다.',
          actions: [
            FilledButton(onPressed: () => open(const SanctionsPage()), child: const Text('조치 내역·이의신청')),
            OutlinedButton(onPressed: () => open(const NoticesPage()), child: const Text('알림')),
            OutlinedButton(onPressed: () => open(const InquiriesPage()), child: const Text('문의')),
            TextButton(onPressed: () => app.refreshMe().catchError((_) {}), child: const Text('다시 확인')),
            TextButton(onPressed: () => app.logout(), child: const Text('로그아웃')),
          ],
        ),
      ),
    );
  }
}
