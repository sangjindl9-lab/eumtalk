import '../core/app_update.dart';
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

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    HomeShell._requestedTab.addListener(_onTabRequest);
    // 하루에 한 번 출석 체크 권유(잠깐 뒤에 띄워 첫 화면을 가리지 않는다)
    Future<void>.delayed(const Duration(seconds: 2), () async {
      if (!mounted) return;
      final app = AppScope.read(context);
      if (app.me?.suspended ?? false) return;
      await AppUpdate.prompt(context, app.api);
      if (!mounted) return;
      final g = app.me?.gender;
      if (g != 'male' && g != 'female') await _askGender();
      if (mounted) await maybePromptAttendance(context);
    });
  }

  // 앱을 다시 열었을 때(백그라운드 → 앞)도 새 버전을 확인한다.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) AppUpdate.prompt(context, AppScope.read(context).api);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    HomeShell._requestedTab.removeListener(_onTabRequest);
    super.dispose();
  }

  /// 남녀 구분: 성별을 넣지 않은 기존 회원에게 한 번 묻는다.
  Future<void> _askGender() async {
    final app = AppScope.read(context);
    final picked = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => PopScope(
        canPop: false,
        child: AlertDialog(
          title: const Text('성별을 알려 주세요'),
          content: const Text('이음톡은 남녀 구분이 표시돼요. 한 번 선택하면 프로필에 함께 보여요.'),
          actions: [
            for (final e in const {'female': '여자', 'male': '남자'}.entries)
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: genderColor(e.key)),
                onPressed: () => Navigator.of(ctx).pop(e.key),
                icon: Icon(e.key == 'female' ? Icons.female : Icons.male),
                label: Text(e.value),
              ),
          ],
        ),
      ),
    );
    if (picked == null) return;
    try {
      await app.updateMe({'gender': picked});
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
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
