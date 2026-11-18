import 'package:material_ui/material_ui.dart';

import 'chats.dart';
import 'me.dart';
import 'nearby.dart';
import 'widgets.dart';

/// 하단 탭 다섯 개. 폴드 펼친 화면처럼 넓으면 옆 레일로 바뀐다.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  void _go(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final scheme = Theme.of(context).colorScheme;

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
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Icon(icon),
        ),
      ),
    );

    final tabs = <({String label, Widget icon, Widget selectedIcon})>[
      (
        label: '주변',
        icon: const Icon(Icons.near_me_outlined),
        selectedIcon: const Icon(Icons.near_me),
      ),
      (
        label: '모임',
        icon: const Icon(Icons.groups_outlined),
        selectedIcon: const Icon(Icons.groups),
      ),
      (
        label: '동네',
        icon: const Icon(Icons.storefront_outlined),
        selectedIcon: const Icon(Icons.storefront),
      ),
      (
        label: '대화',
        icon: chatIcon(Icons.chat_bubble_outline),
        selectedIcon: chatIcon(Icons.chat_bubble),
      ),
      (
        label: '내 정보',
        icon: const Icon(Icons.person_outline),
        selectedIcon: const Icon(Icons.person),
      ),
    ];

    final pages = <Widget>[
      NearbyTab(onFindGroups: () => _go(1)),
      const _ComingSoon(
        title: '모임',
        icon: Icons.groups_outlined,
        headline: '지역방과 관심사 모임은 다음 단계에서 열립니다',
        body: '운영자가 여는 상설 지역방과 회원이 만드는 관심사 그룹방이 이 탭에 들어옵니다.',
      ),
      const _ComingSoon(
        title: '동네',
        icon: Icons.storefront_outlined,
        headline: '동네 게시판과 장터는 그다음 단계에서 열립니다',
        body: '일상·질문·취미·모임 모집 글과 판매·구매·무료 나눔이 이 탭에 들어옵니다.',
      ),
      const ChatsTab(),
      const MeTab(),
    ];

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
                    destinations: [
                      for (final t in tabs)
                        NavigationRailDestination(
                          icon: t.icon,
                          selectedIcon: t.selectedIcon,
                          label: Text(t.label),
                        ),
                    ],
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
            destinations: [
              for (final t in tabs)
                NavigationDestination(
                  icon: t.icon,
                  selectedIcon: t.selectedIcon,
                  label: t.label,
                ),
            ],
          ),
        );
      },
    );
  }
}

class _ComingSoon extends StatelessWidget {
  const _ComingSoon({
    required this.title,
    required this.icon,
    required this.headline,
    required this.body,
  });
  final String title;
  final IconData icon;
  final String headline;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: StateView(icon: icon, title: headline, message: body),
    );
  }
}
