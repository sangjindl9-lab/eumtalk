import 'package:material_ui/material_ui.dart';

import 'board.dart';
import 'chats.dart';
import 'growth.dart' show maybePromptAttendance;
import 'me.dart';
import 'me_more.dart';
import 'nearby.dart';
import 'rooms.dart';
import 'widgets.dart';

/// 하단 탭 다섯 개. 폴드 펼친 화면처럼 넓으면 옆 레일로 바뀐다.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  /// 알림을 눌렀을 때 탭을 바꾸기 위한 통로
  static final ValueNotifier<int?> _requestedTab = ValueNotifier<int?>(null);
  static void selectTab(int index) => _requestedTab.value = index;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    HomeShell._requestedTab.addListener(_onTabRequest);
    // 하루에 한 번 출석 체크 권유(잠깐 뒤에 띄워 첫 화면을 가리지 않는다)
    Future<void>.delayed(const Duration(seconds: 2), () {
      if (mounted && !(AppScope.read(context).me?.suspended ?? false)) maybePromptAttendance(context);
    });
  }

  @override
  void dispose() {
    HomeShell._requestedTab.removeListener(_onTabRequest);
    super.dispose();
  }

  void _onTabRequest() {
    final i = HomeShell._requestedTab.value;
    if (i != null && mounted) setState(() => _index = i);
    HomeShell._requestedTab.value = null;
  }

  void _go(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final scheme = Theme.of(context).colorScheme;
    // 이용 정지 중에는 조치 확인·이의신청 화면만 보여준다.
    if (app.me?.suspended ?? false) return const SuspendedPage();

    // 대화 탭: 새 요청 수(왼쪽, 강조색)와 읽지 않은 메시지 수(오른쪽, 빨강)를 따로 보여준다.
    Widget chatIcon(IconData icon) => Badge(
      alignment: AlignmentDirectional.topStart,
      backgroundColor: scheme.tertiary,
      textColor: scheme.onTertiary,
      isLabelVisible: app.pendingGreetings > 0,
      label: Text('요청 ${app.pendingGreetings}'),
      child: Badge(
        isLabelVisible: app.unreadTotal > 0,
        label: Text(app.unreadTotal > 99 ? '99+' : '${app.unreadTotal}'),
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 14), child: Icon(icon)),
      ),
    );

    final tabs = <({String label, Widget icon, Widget selectedIcon})>[
      (label: '주변', icon: const Icon(Icons.near_me_outlined), selectedIcon: const Icon(Icons.near_me)),
      (label: '모임', icon: const Icon(Icons.groups_outlined), selectedIcon: const Icon(Icons.groups)),
      (label: '동네', icon: const Icon(Icons.storefront_outlined), selectedIcon: const Icon(Icons.storefront)),
      (label: '대화', icon: chatIcon(Icons.chat_bubble_outline), selectedIcon: chatIcon(Icons.chat_bubble)),
      (
        label: '내 정보',
        icon: Badge(isLabelVisible: app.unreadNotices > 0, child: const Icon(Icons.person_outline)),
        selectedIcon: Badge(isLabelVisible: app.unreadNotices > 0, child: const Icon(Icons.person)),
      ),
    ];

    final pages = <Widget>[NearbyTab(onFindGroups: () => _go(1)), const RoomsTab(), const BoardTab(), const ChatsTab(), const MeTab()];

    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 720;
        final body = IndexedStack(index: _index, children: pages);
        if (wide) {
          return Scaffold(
            body: SafeArea(
              child: Row(
                children: [
                  NavigationRail(
                    selectedIndex: _index,
                    onDestinationSelected: _go,
                    labelType: NavigationRailLabelType.all,
                    destinations: [for (final t in tabs) NavigationRailDestination(icon: t.icon, selectedIcon: t.selectedIcon, label: Text(t.label))],
                  ),
                  const VerticalDivider(width: 1),
                  Expanded(child: body),
                ],
              ),
            ),
          );
        }
        return Scaffold(
          body: body,
          bottomNavigationBar: NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: _go,
            destinations: [for (final t in tabs) NavigationDestination(icon: t.icon, selectedIcon: t.selectedIcon, label: t.label)],
          ),
        );
      },
    );
  }
}
