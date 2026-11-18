import 'package:material_ui/material_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/app_state.dart';
import 'core/brand.dart';
import 'ui/home.dart';
import 'ui/onboarding.dart';
import 'ui/widgets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Brand.load();
  final prefs = await SharedPreferences.getInstance();
  final app = AppState(prefs);
  runApp(EumTalkApp(app: app));
  app.boot();
}

class EumTalkApp extends StatefulWidget {
  const EumTalkApp({super.key, required this.app});
  final AppState app;

  @override
  State<EumTalkApp> createState() => _EumTalkAppState();
}

class _EumTalkAppState extends State<EumTalkApp> {
  final _navigatorKey = GlobalKey<NavigatorState>();
  bool _wasSignedIn = false;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_onChange);
  }

  @override
  void dispose() {
    widget.app.removeListener(_onChange);
    super.dispose();
  }

  // 로그인·로그아웃이 바뀌면 그 위에 쌓인 화면(가입 단계, 대화방 등)을 모두 걷어낸다.
  void _onChange() {
    final signedIn = widget.app.signedIn;
    if (signedIn != _wasSignedIn) {
      _wasSignedIn = signedIn;
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    }
  }

  ThemeData _theme(Brightness brightness) {
    final brand = Brand.instance;
    final scheme = ColorScheme.fromSeed(seedColor: brand.seed, tertiary: brand.accent, brightness: brightness);
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent, centerTitle: false),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest.withAlpha(120),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surfaceContainerLow,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      app: widget.app,
      child: MaterialApp(
        title: Brand.instance.appName,
        navigatorKey: _navigatorKey,
        debugShowCheckedModeBanner: false,
        theme: _theme(Brightness.light),
        darkTheme: _theme(Brightness.dark),
        themeMode: ThemeMode.system,
        locale: const Locale('ko'),
        supportedLocales: const [Locale('ko'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: ListenableBuilder(
          listenable: widget.app,
          builder: (context, _) {
            final app = widget.app;
            if (app.booting) {
              return const Scaffold(body: Center(child: CircularProgressIndicator()));
            }
            return app.signedIn ? const HomeShell() : const IntroPage();
          },
        ),
      ),
    );
  }
}
