import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';

import '../core/app_state.dart';
import '../core/models.dart';
import 'profile_page.dart';
import 'widgets.dart';

/// 1대1 대화 화면. 메시지와 입력창에만 집중하도록 구성한다.
class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.conversationId,
    required this.title,
  });
  final String conversationId;
  final String title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  late AppState _app;
  late ChatController _chat;
  late final TextEditingController _input;
  bool _ready = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ready) return;
    _ready = true;
    _app = AppScope.read(context);
    _chat = _app.chat(widget.conversationId);
    _input = TextEditingController(text: _app.draftFor(widget.conversationId));
    _app.openConversationId = widget.conversationId;
    _chat.load().then((_) => _chat.markRead());
  }

  @override
  void dispose() {
    if (_app.openConversationId == widget.conversationId) {
      _app.openConversationId = null;
    }
    _app.saveDraft(widget.conversationId, _input.text);
    _input.dispose();
    super.dispose();
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    _app.enqueue(widget.conversationId, text);
    _input.clear();
    _app.saveDraft(widget.conversationId, '');
    setState(() {});
  }

  Future<void> _block(Conversation conv) async {
    final ok = await confirm(
      context,
      title: '${conv.peerNickname} 님을 차단할까요?',
      message: '차단하면 새 인사와 메시지·알림이 오지 않고, 서로 주변 목록에 보이지 않습니다.',
      action: '차단',
    );
    if (!ok) return;
    try {
      await _app.api.post('/v1/blocks', {'userId': conv.peerId});
      await _app.refreshInbox();
      if (mounted) showMessage(context, '차단했습니다.');
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  void _messageMenu(Message m, bool mine) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.copy_outlined),
              title: const Text('복사'),
              onTap: () {
                Clipboard.setData(ClipboardData(text: m.body));
                Navigator.of(sheet).pop();
                showMessage(context, '복사했습니다.');
              },
            ),
            if (!mine)
              ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: const Text('이 메시지 신고'),
                onTap: () {
                  Navigator.of(sheet).pop();
                  showReportSheet(
                    context,
                    targetType: 'message',
                    targetId: m.id,
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([_chat, _app]),
      builder: (context, _) {
        final conv = _app.conversationById(widget.conversationId);
        final myId = _app.me?.userId;
        final messages = _chat.messages;
        final pending = _chat.pending;
        final total = messages.length + pending.length;
        final canSend = conv?.canSend ?? true;

        Widget list;
        if (_chat.loading && messages.isEmpty) {
          list = const StateView.loading();
        } else if (_chat.error != null && messages.isEmpty && pending.isEmpty) {
          list = StateView(
            icon: Icons.cloud_off_outlined,
            title: '대화를 불러오지 못했어요',
            message: _chat.error,
            actions: [
              FilledButton(onPressed: _chat.load, child: const Text('다시 시도')),
            ],
          );
        } else if (total == 0) {
          list = const StateView(
            icon: Icons.chat_bubble_outline,
            title: '첫 메시지를 보내 보세요',
          );
        } else {
          list = NotificationListener<ScrollNotification>(
            onNotification: (n) {
              if (n.metrics.pixels > n.metrics.maxScrollExtent - 200) {
                _chat.loadOlder();
              }
              return false;
            },
            child: ListView.builder(
              reverse: true,
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              itemCount: total + 1,
              itemBuilder: (context, index) {
                if (index == total) {
                  return _chat.loadingOlder
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: Center(
                            child: SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                        )
                      : const SizedBox(height: 4);
                }
                final i = total - 1 - index; // 시간순 위치
                if (i >= messages.length) {
                  final p = pending[i - messages.length];
                  return _PendingBubble(
                    pending: p,
                    onRetry: () => _app.retry(p),
                    onDiscard: () => _app.discard(p),
                  );
                }
                final m = messages[i];
                final mine = m.senderId == myId;
                final prev = i > 0 ? messages[i - 1] : null;
                final newDay =
                    prev == null ||
                    prev.createdAt.day != m.createdAt.day ||
                    prev.createdAt.month != m.createdAt.month ||
                    prev.createdAt.year != m.createdAt.year;
                final read = mine && conv != null && m.seq <= conv.peerReadSeq;
                return Column(
                  children: [
                    if (newDay)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          '${m.createdAt.year}년 ${m.createdAt.month}월 ${m.createdAt.day}일',
                          style: t.textTheme.labelMedium?.copyWith(
                            color: t.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    _Bubble(
                      text: m.body,
                      mine: mine,
                      greeting: m.kind == 'greeting',
                      footer: mine
                          ? '${read ? '읽음 · ' : ''}${clockTime(m.createdAt)}'
                          : clockTime(m.createdAt),
                      onLongPress: () => _messageMenu(m, mine),
                    ),
                  ],
                );
              },
            ),
          );
        }

        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: InkWell(
              onTap: conv == null || !conv.peerActive
                  ? null
                  : () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ProfilePage(userId: conv.peerId),
                      ),
                    ),
              child: Row(
                children: [
                  Avatar(
                    name: conv?.peerNickname ?? widget.title,
                    colorIndex: conv?.peerColor ?? 0,
                    size: 36,
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      conv?.peerNickname ?? widget.title,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              if (conv != null)
                PopupMenuButton<String>(
                  onSelected: (v) {
                    if (v == 'block') _block(conv);
                    if (v == 'report') {
                      showReportSheet(
                        context,
                        targetType: 'profile',
                        targetId: conv.peerId,
                      );
                    }
                  },
                  itemBuilder: (context) => [
                    if (!conv.blockedByMe)
                      const PopupMenuItem(value: 'block', child: Text('차단')),
                    const PopupMenuItem(value: 'report', child: Text('신고')),
                  ],
                ),
            ],
          ),
          body: SafeArea(
            child: ContentWidth(
              child: Column(
                children: [
                  if (!_app.connected)
                    Container(
                      width: double.infinity,
                      color: t.colorScheme.surfaceContainerHighest,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 6,
                      ),
                      child: Text(
                        '연결이 끊겼어요. 보낸 메시지는 저장해 두었다가 연결되면 전송합니다.',
                        style: t.textTheme.bodySmall,
                      ),
                    ),
                  Expanded(child: list),
                  if (canSend)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 8, 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _input,
                              minLines: 1,
                              maxLines: 5,
                              maxLength: 2000,
                              textInputAction: TextInputAction.newline,
                              decoration: const InputDecoration(
                                hintText: '메시지 입력',
                                counterText: '',
                                contentPadding: EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 12,
                                ),
                              ),
                              onChanged: (v) {
                                _app.saveDraft(widget.conversationId, v);
                                setState(() {});
                              },
                            ),
                          ),
                          const SizedBox(width: 6),
                          IconButton.filled(
                            onPressed: _input.text.trim().isEmpty
                                ? null
                                : _send,
                            icon: const Icon(Icons.arrow_upward),
                            tooltip: '보내기',
                          ),
                        ],
                      ),
                    )
                  else
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      color: t.colorScheme.surfaceContainerHighest,
                      child: Text(
                        conv != null && conv.blockedByMe
                            ? '차단한 회원입니다. 내 정보 > 차단 목록에서 해제할 수 있어요.'
                            : '메시지를 보낼 수 없는 대화입니다.',
                        textAlign: TextAlign.center,
                        style: t.textTheme.bodyMedium,
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.text,
    required this.mine,
    required this.footer,
    this.greeting = false,
    this.onLongPress,
    this.footerWidget,
  });
  final String text;
  final bool mine;
  final bool greeting;
  final String footer;
  final Widget? footerWidget;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final bg = mine
        ? t.colorScheme.primary
        : t.colorScheme.surfaceContainerHighest;
    final fg = mine ? t.colorScheme.onPrimary : t.colorScheme.onSurface;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width.clamp(0, 720) * 0.76,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Column(
            crossAxisAlignment: mine
                ? CrossAxisAlignment.end
                : CrossAxisAlignment.start,
            children: [
              GestureDetector(
                onLongPress: onLongPress,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: bg,
                    borderRadius: BorderRadius.only(
                      topLeft: const Radius.circular(18),
                      topRight: const Radius.circular(18),
                      bottomLeft: Radius.circular(mine ? 18 : 4),
                      bottomRight: Radius.circular(mine ? 4 : 18),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (greeting)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text(
                            '인사말',
                            style: t.textTheme.labelSmall?.copyWith(
                              color: fg.withAlpha(180),
                            ),
                          ),
                        ),
                      Text(
                        text,
                        style: t.textTheme.bodyLarge?.copyWith(color: fg),
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
                child:
                    footerWidget ??
                    Text(
                      footer,
                      style: t.textTheme.labelSmall?.copyWith(
                        color: t.colorScheme.onSurfaceVariant,
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

/// 전송 중 · 전송 대기 · 실패를 구분해서 보여준다.
class _PendingBubble extends StatelessWidget {
  const _PendingBubble({
    required this.pending,
    required this.onRetry,
    required this.onDiscard,
  });
  final PendingMessage pending;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget footer;
    switch (pending.state) {
      case PendingState.sending:
        footer = Text(
          '전송 중…',
          style: t.textTheme.labelSmall?.copyWith(
            color: t.colorScheme.onSurfaceVariant,
          ),
        );
        break;
      case PendingState.queued:
        footer = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.schedule,
              size: 12,
              color: t.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 4),
            Text(
              '연결되면 전송',
              style: t.textTheme.labelSmall?.copyWith(
                color: t.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        );
        break;
      case PendingState.failed:
        footer = Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 4,
          children: [
            Icon(Icons.error_outline, size: 14, color: t.colorScheme.error),
            Text(
              pending.error ?? '전송 실패',
              style: t.textTheme.labelSmall?.copyWith(
                color: t.colorScheme.error,
              ),
            ),
            TextButton(
              onPressed: onRetry,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('다시 보내기'),
            ),
            TextButton(
              onPressed: onDiscard,
              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('삭제'),
            ),
          ],
        );
        break;
    }
    return Opacity(
      opacity: pending.state == PendingState.failed ? 1 : 0.7,
      child: _Bubble(
        text: pending.text,
        mine: true,
        footer: '',
        footerWidget: footer,
      ),
    );
  }
}
