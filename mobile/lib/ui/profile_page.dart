import 'package:material_ui/material_ui.dart';

import '../core/api.dart';
import '../core/models.dart';
import 'chat_page.dart';
import 'nearby.dart';
import 'widgets.dart';

/// 다른 회원의 프로필. 인사 보내기·차단·신고를 여기서 실행한다.
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key, required this.userId, this.preview});
  final String userId;
  final PublicProfile? preview;

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  PublicProfile? _profile;
  String? _conversationId;
  String? _pending; // sent | received
  String? _greetingId;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _profile = widget.preview;
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final app = AppScope.read(context);
    try {
      final res = await app.api.get('/v1/users/${widget.userId}');
      if (!mounted) return;
      final rel = res['relation'] as Map<String, dynamic>;
      setState(() {
        _profile = PublicProfile.fromJson(
          res['profile'] as Map<String, dynamic>,
        );
        _conversationId = rel['conversationId'] as String?;
        _pending = rel['pendingGreeting'] as String?;
        _greetingId = rel['greetingId'] as String?;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  void _openChat(String conversationId) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatPage(
          conversationId: conversationId,
          title: _profile?.nickname ?? '',
        ),
      ),
    );
  }

  Future<void> _greet() async {
    final app = AppScope.read(context);
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (context) => _GreetingSheet(nickname: _profile?.nickname ?? ''),
    );
    if (text == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/greetings', {
        'toUserId': widget.userId,
        'text': text,
      });
      await app.refreshInbox();
      if (!mounted) return;
      final status = res['status'];
      if (status == 'sent') {
        showMessage(context, '인사를 보냈어요. 상대가 수락하면 대화가 열립니다.');
      } else {
        showMessage(
          context,
          status == 'matched' ? '서로 인사를 보냈네요! 대화가 열렸습니다.' : '이미 대화 중인 회원입니다.',
        );
        _openChat(res['conversationId'] as String);
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
      await _load();
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/greetings/$_greetingId/accept');
      await app.refreshInbox();
      if (!mounted) return;
      _openChat(res['conversationId'] as String);
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _block() async {
    final app = AppScope.read(context);
    final ok = await confirm(
      context,
      title: '${_profile?.nickname ?? '이 회원'} 님을 차단할까요?',
      message: '차단하면 서로 주변 목록에 보이지 않고, 새 인사와 메시지·알림이 오지 않습니다. 상대에게는 알리지 않습니다.',
      action: '차단',
    );
    if (!ok) return;
    try {
      await app.api.post('/v1/blocks', {'userId': widget.userId});
      await app.refreshInbox();
      if (!mounted) return;
      showMessage(context, '차단했습니다. 내 정보 > 차단 목록에서 해제할 수 있어요.');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final p = _profile;
    Widget body;
    if (p == null) {
      body = _error != null
          ? StateView(
              icon: Icons.person_off_outlined,
              title: '프로필을 볼 수 없어요',
              message: _error,
              actions: [
                OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('돌아가기'),
                ),
              ],
            )
          : const StateView.loading();
    } else {
      final meta = [
        p.ageBand,
        if (p.genderLabel != null) p.genderLabel!,
      ].join(' · ');
      body = ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Row(
            children: [
              Avatar(name: p.nickname, colorIndex: p.avatarColor, size: 84),
              const SizedBox(width: 18),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      p.nickname,
                      style: t.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      meta,
                      style: t.textTheme.bodyLarge?.copyWith(
                        color: t.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      [
                        p.proximityLabel,
                        if (p.proximityLabel != p.regionName) p.regionName,
                        if (p.activityLabel != null) p.activityLabel!,
                      ].join(' · '),
                      style: t.textTheme.bodyMedium?.copyWith(
                        color: t.colorScheme.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('자기소개', style: t.textTheme.titleSmall),
          const SizedBox(height: 6),
          Text(
            p.bio.isEmpty ? '아직 자기소개를 쓰지 않았어요.' : p.bio,
            style: t.textTheme.bodyLarge,
          ),
          const SizedBox(height: 24),
          if (p.commonInterests.isNotEmpty) ...[
            Text(
              '공통 관심사 ${p.commonInterests.length}개',
              style: t.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            InterestTags(
              interests: p.commonInterests,
              common: p.commonInterests,
            ),
            const SizedBox(height: 20),
          ],
          Text('관심사', style: t.textTheme.titleSmall),
          const SizedBox(height: 8),
          if (p.interests.isEmpty)
            Text('등록한 관심사가 없어요.', style: t.textTheme.bodyMedium)
          else
            InterestTags(interests: p.interests, common: p.commonInterests),
        ],
      );
    }

    Widget? action;
    if (p != null) {
      if (_conversationId != null) {
        action = FilledButton.icon(
          onPressed: () => _openChat(_conversationId!),
          icon: const Icon(Icons.chat_bubble_outline),
          label: const Text('대화 열기'),
        );
      } else if (_pending == 'sent') {
        action = const FilledButton(
          onPressed: null,
          child: Text('인사를 보냈어요 · 답을 기다리는 중'),
        );
      } else if (_pending == 'received') {
        action = FilledButton.icon(
          onPressed: _busy ? null : _accept,
          icon: const Icon(Icons.check),
          label: const Text('받은 인사 수락하고 대화하기'),
        );
      } else if (!p.acceptsGreetings) {
        action = const FilledButton(
          onPressed: null,
          child: Text('새 인사를 받지 않는 회원입니다'),
        );
      } else {
        action = FilledButton.icon(
          onPressed: _busy ? null : _greet,
          icon: const Icon(Icons.waving_hand_outlined),
          label: const Text('인사 보내기'),
        );
      }
    }

    return Scaffold(
      appBar: AppBar(
        actions: [
          if (p != null)
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'block') _block();
                if (v == 'report') {
                  showReportSheet(
                    context,
                    targetType: 'profile',
                    targetId: widget.userId,
                  );
                }
              },
              itemBuilder: (context) => const [
                PopupMenuItem(value: 'block', child: Text('차단')),
                PopupMenuItem(value: 'report', child: Text('신고')),
              ],
            ),
        ],
      ),
      body: ContentWidth(child: body),
      bottomNavigationBar: action == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: SizedBox(height: 54, child: action),
              ),
            ),
    );
  }
}

class _GreetingSheet extends StatefulWidget {
  const _GreetingSheet({required this.nickname});
  final String nickname;

  @override
  State<_GreetingSheet> createState() => _GreetingSheetState();
}

class _GreetingSheetState extends State<_GreetingSheet> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final ready = _text.text.trim().isNotEmpty;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        0,
        20,
        20 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${widget.nickname} 님에게 인사', style: t.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(
            '인사는 한 번만 보낼 수 있고, 상대가 수락해야 대화가 열립니다. 수락 전에는 사진과 링크를 보낼 수 없어요.',
            style: t.textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _text,
            autofocus: true,
            maxLength: 100,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(
              hintText: '예) 안녕하세요, 저도 등산 좋아해서 인사드려요.',
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 4),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: ready
                  ? () => Navigator.of(context).pop(_text.text.trim())
                  : null,
              child: const Text('인사 보내기'),
            ),
          ),
        ],
      ),
    );
  }
}
