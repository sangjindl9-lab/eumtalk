import 'package:material_ui/material_ui.dart';

import '../core/models.dart';
import 'chat_page.dart';
import 'nearby.dart';
import 'profile_page.dart';
import 'widgets.dart';

/// 대화 탭: 새 인사 요청과 진행 중인 대화를 구분해서 보여준다.
class ChatsTab extends StatelessWidget {
  const ChatsTab({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final t = Theme.of(context);

    Widget body;
    if (!app.inboxLoaded && app.inboxError == null) {
      body = const StateView.loading();
    } else if (!app.inboxLoaded) {
      body = StateView(
        icon: Icons.cloud_off_outlined,
        title: '대화 목록을 불러오지 못했어요',
        message: app.inboxError,
        actions: [
          FilledButton(onPressed: app.refreshInbox, child: const Text('다시 시도')),
        ],
      );
    } else if (app.received.isEmpty && app.conversations.isEmpty) {
      body = const StateView(
        icon: Icons.forum_outlined,
        title: '아직 대화가 없어요',
        message: '주변 탭에서 마음이 맞는 사람에게 인사를 보내 보세요. 상대가 수락하면 여기에 대화가 생깁니다.',
      );
    } else {
      body = RefreshIndicator(
        onRefresh: app.refreshInbox,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            if (app.received.isNotEmpty) ...[
              _SectionHeader(
                label: '새 인사 요청',
                count: app.received.length,
                color: t.colorScheme.tertiary,
              ),
              for (final g in app.received) _GreetingTile(greeting: g),
              const SizedBox(height: 8),
            ],
            _SectionHeader(
              label: '대화',
              count: app.unreadTotal,
              color: t.colorScheme.error,
              countSuffix: '개 안 읽음',
            ),
            if (app.conversations.isEmpty)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  '수락한 대화가 여기에 표시됩니다.',
                  style: t.textTheme.bodyMedium?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            for (final c in app.conversations)
              _ConversationTile(conversation: c),
          ],
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('대화'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const SentGreetingsPage(),
              ),
            ),
            child: const Text('보낸 인사'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: ContentWidth(
        child: Column(
          children: [
            if (!app.connected && app.inboxLoaded) const _OfflineBar(),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}

class _OfflineBar extends StatelessWidget {
  const _OfflineBar();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Container(
      width: double.infinity,
      color: t.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(
        '연결을 다시 시도하는 중… 작성한 메시지는 저장해 두었다가 보냅니다.',
        style: t.textTheme.bodySmall,
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.label,
    required this.count,
    required this.color,
    this.countSuffix = '건',
  });
  final String label;
  final int count;
  final Color color;
  final String countSuffix;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
      child: Row(
        children: [
          Text(label, style: t.textTheme.titleSmall),
          const SizedBox(width: 8),
          if (count > 0)
            Text(
              '$count$countSuffix',
              style: t.textTheme.labelLarge?.copyWith(
                color: color,
                fontWeight: FontWeight.w700,
              ),
            ),
        ],
      ),
    );
  }
}

class _GreetingTile extends StatelessWidget {
  const _GreetingTile({required this.greeting});
  final Greeting greeting;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final s = greeting.sender;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => showModalBottomSheet<void>(
            context: context,
            isScrollControlled: true,
            showDragHandle: true,
            useSafeArea: true,
            builder: (_) => GreetingReviewSheet(greeting: greeting),
          ),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Avatar(name: s.nickname, colorIndex: s.avatarColor),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${s.nickname} · ${s.ageBand} · ${s.proximityLabel}',
                        style: t.textTheme.titleSmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        greeting.body,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 받은 인사를 프로필과 함께 보고 수락·거절·차단을 고른다.
class GreetingReviewSheet extends StatefulWidget {
  const GreetingReviewSheet({super.key, required this.greeting});
  final Greeting greeting;

  @override
  State<GreetingReviewSheet> createState() => _GreetingReviewSheetState();
}

class _GreetingReviewSheetState extends State<GreetingReviewSheet> {
  bool _busy = false;

  Future<void> _act(String action) async {
    if (_busy) return; // 버튼을 두 번 눌러도 요청은 한 번만 보낸다. (서버도 중복 수락을 걸러낸다)
    final app = AppScope.read(context);
    final g = widget.greeting;
    if (action == 'block') {
      final ok = await confirm(
        context,
        title: '${g.sender.nickname} 님을 차단할까요?',
        message: '인사를 거절하고, 앞으로 이 회원의 인사·메시지·알림을 받지 않습니다.',
        action: '차단',
      );
      if (!ok || !mounted) return;
    }
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/greetings/${g.id}/$action');
      await app.refreshInbox();
      if (!mounted) return;
      final navigator = Navigator.of(context);
      navigator.pop();
      if (action == 'accept') {
        navigator.push(
          MaterialPageRoute<void>(
            builder: (_) => ChatPage(
              conversationId: res['conversationId'] as String,
              title: g.sender.nickname,
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        showMessage(context, e.toString());
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final g = widget.greeting;
    final s = g.sender;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Avatar(name: s.nickname, colorIndex: s.avatarColor, size: 60),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.nickname, style: t.textTheme.titleLarge),
                    Text(
                      '${s.ageBand} · ${s.proximityLabel}',
                      style: t.textTheme.bodyMedium?.copyWith(
                        color: t.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => ProfilePage(userId: s.userId, preview: s),
                  ),
                ),
                child: const Text('프로필 보기'),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: t.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Text(g.body, style: t.textTheme.bodyLarge),
          ),
          if (s.interests.isNotEmpty) ...[
            const SizedBox(height: 14),
            InterestTags(interests: s.interests, common: s.commonInterests),
          ],
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: FilledButton(
              onPressed: _busy ? null : () => _act('accept'),
              child: const Text('수락하고 대화하기'),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => _act('decline'),
                  child: const Text('거절'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => _act('block'),
                  child: const Text('차단'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextButton(
                  onPressed: _busy
                      ? null
                      : () => showReportSheet(
                          context,
                          targetType: 'greeting',
                          targetId: g.id,
                        ),
                  child: const Text('신고'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.conversation});
  final Conversation conversation;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final t = Theme.of(context);
    final c = conversation;
    final waiting = app.outbox.where((p) => p.conversationId == c.id).length;
    final mine = c.lastSenderId == app.me?.userId;
    final preview = waiting > 0
        ? '보내지 못한 메시지 $waiting개'
        : '${mine ? '나: ' : ''}${c.lastBody ?? ''}';
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
      leading: Avatar(name: c.peerNickname, colorIndex: c.peerColor),
      title: Text(
        c.peerNickname,
        style: TextStyle(
          fontWeight: c.unreadCount > 0 ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
      subtitle: Text(
        preview,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: waiting > 0 ? TextStyle(color: t.colorScheme.error) : null,
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(shortTime(c.updatedAt), style: t.textTheme.bodySmall),
          const SizedBox(height: 6),
          if (c.unreadCount > 0)
            Badge(label: Text(c.unreadCount > 99 ? '99+' : '${c.unreadCount}'))
          else
            const SizedBox(height: 16),
        ],
      ),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChatPage(conversationId: c.id, title: c.peerNickname),
        ),
      ),
    );
  }
}

class SentGreetingsPage extends StatefulWidget {
  const SentGreetingsPage({super.key});

  @override
  State<SentGreetingsPage> createState() => _SentGreetingsPageState();
}

class _SentGreetingsPageState extends State<SentGreetingsPage> {
  List<SentGreeting>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final res = await AppScope.read(context).api
          .get('/v1/greetings', query: {'box': 'sent'});
      if (!mounted) return;
      setState(() {
        _items = (res['items'] as List)
            .map((e) => SentGreeting.fromJson(e as Map<String, dynamic>))
            .toList();
        _error = null;
      });
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
              actions: [
                FilledButton(onPressed: _load, child: const Text('다시 시도')),
              ],
            );
    } else if (items.isEmpty) {
      body = const StateView(
        icon: Icons.waving_hand_outlined,
        title: '보낸 인사가 없어요',
        message: '최근 30일 동안 보낸 인사가 여기에 표시됩니다.',
      );
    } else {
      body = ListView(
        children: [
          for (final g in items)
            ListTile(
              leading: Avatar(
                name: g.receiverNickname,
                colorIndex: g.receiverColor,
              ),
              title: Text(g.receiverNickname),
              subtitle: Text(
                g.body,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: Text(
                g.status == 'pending'
                    ? '답을 기다리는 중'
                    : g.status == 'accepted'
                    ? '대화 중'
                    : '종료됨',
              ),
              onTap: g.conversationId == null
                  ? null
                  : () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ChatPage(
                          conversationId: g.conversationId!,
                          title: g.receiverNickname,
                        ),
                      ),
                    ),
            ),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('보낸 인사')),
      body: ContentWidth(child: body),
    );
  }
}
