import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';

import 'package:webview_flutter/webview_flutter.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/brand.dart';
import 'profile_form.dart';
import 'widgets.dart';

/// 첫 화면: 어떤 서비스인지 설명하고 가입을 시작한다.
class IntroPage extends StatefulWidget {
  const IntroPage({super.key});

  @override
  State<IntroPage> createState() => _IntroPageState();
}

class _IntroPageState extends State<IntroPage> {
  bool? _signupAvailable;
  String _flow = 'code';
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _check());
  }

  Future<void> _check() async {
    final app = AppScope.read(context);
    setState(() => _error = null);
    try {
      final cfg = await app.api.get('/v1/app-config');
      if (mounted) {
        setState(() {
          _signupAvailable = cfg['signupAvailable'] == true;
          _flow = (cfg['identityFlow'] ?? 'code') as String;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _editServer() async {
    final app = AppScope.read(context);
    final controller = TextEditingController(text: app.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('시험 서버 주소'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(hintText: 'https://…'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('취소')),
          FilledButton(onPressed: () => Navigator.of(context).pop(controller.text), child: const Text('저장')),
        ],
      ),
    );
    if (url != null && url.trim().isNotEmpty) {
      await app.setBaseUrl(url);
      _check();
    }
  }

  @override
  Widget build(BuildContext context) {
    final brand = Brand.instance;
    final t = Theme.of(context);
    Widget point(IconData icon, String title, String body) => Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: t.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(14)),
            child: Icon(icon, color: t.colorScheme.onPrimaryContainer),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: t.textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(body, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              ],
            ),
          ),
        ],
      ),
    );

    return Scaffold(
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 520,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
            children: [
              GestureDetector(
                onLongPress: AppState.allowServerOverride ? _editServer : null,
                child: Text(
                  brand.appName,
                  style: t.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w800, color: t.colorScheme.primary),
                ),
              ),
              const SizedBox(height: 8),
              Text(brand.tagline, style: t.textTheme.titleMedium),
              const SizedBox(height: 32),
              point(Icons.near_me_outlined, '내 주변 사람 찾기', '가까운 지역에서 관심사가 맞는 사람을 찾아요. 정확한 위치는 누구에게도 보이지 않습니다.'),
              point(Icons.waving_hand_outlined, '인사하고, 수락하면 대화', '짧은 인사를 보내고 상대가 수락했을 때만 1대1 대화가 열립니다.'),
              point(Icons.groups_outlined, '지역방과 관심사 모임', '동네 소식과 취미 모임을 한곳에서 나눠요.'),
              point(
                Icons.verified_user_outlined,
                '성인 회원 전용',
                _flow == 'anonymous' ? '만 19세 이상만 이용할 수 있어요. 휴대폰 번호나 실명 없이 익명으로 시작합니다.' : '휴대폰 인증과 성인 확인을 마친 회원만 이용합니다. 번호·실명·생년월일은 공개되지 않아요.',
              ),
              const SizedBox(height: 8),
              if (_error != null)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.cloud_off_outlined),
                    title: const Text('서버에 연결하지 못했어요'),
                    subtitle: Text(AppState.allowServerOverride ? '$_error\n앱 이름을 길게 누르면 시험 서버 주소를 바꿀 수 있습니다.' : _error!),
                    trailing: TextButton(onPressed: _check, child: const Text('다시 시도')),
                  ),
                )
              else if (_signupAvailable == false)
                const Card(
                  child: ListTile(leading: Icon(Icons.info_outline), title: Text('지금은 새로 가입할 수 없습니다'), subtitle: Text('본인확인 준비가 끝나는 대로 다시 열릴 예정입니다.')),
                ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _signupAvailable == true
                    ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => _flow == 'anonymous' ? const AnonymousStartPage() : (_flow == 'web' ? const IdentityWebPage() : const PhonePage())))
                    : null,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
                child: Text(_flow == 'anonymous' ? '익명으로 시작하기' : '휴대폰 번호로 시작하기'),
              ),
              const SizedBox(height: 12),
              Text(
                _flow == 'anonymous'
                    ? '출생 연도 확인 → 프로필 순서로 바로 시작합니다. 계정은 이 기기에 저장되니 로그아웃하거나 앱을 지우면 다시 들어올 수 없어요.'
                    : (_flow == 'web' ? '휴대폰 본인인증으로 번호와 성인 여부를 확인한 뒤 프로필을 만듭니다.' : '가입은 휴대폰 인증 → 성인 확인 → 프로필 순서로 진행됩니다.'),
                style: t.textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StepScaffold extends StatelessWidget {
  const _StepScaffold({required this.step, required this.title, required this.subtitle, required this.children});
  final int step;
  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text('$step / 3', style: t.textTheme.labelLarge)),
      body: SafeArea(
        child: ContentWidth(
          maxWidth: 520,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
            children: [
              Text(title, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(subtitle, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              const SizedBox(height: 24),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

class PhonePage extends StatefulWidget {
  const PhonePage({super.key});

  @override
  State<PhonePage> createState() => _PhonePageState();
}

class _PhonePageState extends State<PhonePage> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  String? _verificationId;
  String? _devCode;
  bool _busy = false;

  Future<void> _run(Future<void> Function() job) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await job();
    } on ApiException catch (e) {
      if (mounted) showMessage(context, e.message);
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _start() => _run(() async {
    final app = AppScope.read(context);
    final res = await app.api.post('/v1/auth/phone/start', {'phone': _phone.text});
    setState(() {
      _verificationId = res['verificationId'] as String;
      _devCode = res['devCode'] as String?;
      _code.clear();
    });
  });

  Future<void> _verify() => _run(() async {
    final app = AppScope.read(context);
    final res = await app.api.post('/v1/auth/phone/verify', {'verificationId': _verificationId, 'code': _code.text});
    if (res['status'] == 'login') {
      await app.completeLogin(res['token'] as String);
      return;
    }
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AdultPage(signupToken: res['signupToken'] as String)));
  });

  @override
  Widget build(BuildContext context) {
    final sent = _verificationId != null;
    return _StepScaffold(
      step: 1,
      title: '휴대폰 번호 인증',
      subtitle: '번호는 본인 확인에만 쓰이고 다른 회원에게 보이지 않습니다. 이미 가입했다면 바로 로그인됩니다.',
      children: [
        TextField(
          controller: _phone,
          enabled: !sent,
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(11)],
          decoration: const InputDecoration(labelText: '휴대폰 번호', hintText: '01012345678'),
        ),
        const SizedBox(height: 12),
        if (!sent)
          FilledButton(onPressed: _busy ? null : _start, child: const Text('인증번호 받기'))
        else ...[
          TextField(
            controller: _code,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: '인증번호 6자리'),
          ),
          if (_devCode != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('시험 서버입니다. 인증번호는 $_devCode 입니다.', style: Theme.of(context).textTheme.bodySmall),
            ),
          const SizedBox(height: 12),
          FilledButton(onPressed: _busy ? null : _verify, child: const Text('확인')),
          TextButton(onPressed: _busy ? null : () => setState(() => _verificationId = null), child: const Text('번호 다시 입력')),
        ],
      ],
    );
  }
}

/// 익명 가입: 휴대폰·본인인증 없이 출생 연도와 성인 확인(자기 신고)만 받는다.
class AnonymousStartPage extends StatefulWidget {
  const AnonymousStartPage({super.key});

  @override
  State<AnonymousStartPage> createState() => _AnonymousStartPageState();
}

class _AnonymousStartPageState extends State<AnonymousStartPage> {
  final _year = TextEditingController();
  bool _adult = false;
  bool _busy = false;

  Future<void> _start() async {
    if (_busy) return;
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/auth/anonymous/start', {'birthYear': int.tryParse(_year.text), 'adultConfirmed': _adult});
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SignupProfilePage(signupToken: res['signupToken'] as String, ageBand: (res['ageBand'] ?? '') as String),
        ),
      );
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
    return _StepScaffold(
      step: 1,
      title: '성인 확인',
      subtitle: '만 19세 이상만 이용할 수 있습니다. 출생 연도는 연령대 표시에만 쓰이고 공개되지 않습니다.',
      children: [
        TextField(
          controller: _year,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
          decoration: const InputDecoration(labelText: '출생 연도', hintText: '1990'),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        CheckboxListTile(
          value: _adult,
          onChanged: (v) => setState(() => _adult = v ?? false),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          title: const Text('만 19세 이상이며, 나이를 거짓으로 입력하면 이용이 정지될 수 있음에 동의합니다.'),
        ),
        const SizedBox(height: 4),
        Text('휴대폰 번호 없이 익명으로 가입합니다. 계정은 이 기기에만 저장되므로 로그아웃하거나 앱을 지우면 같은 계정으로 다시 들어올 수 없습니다.',
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy || !_adult || _year.text.length != 4 ? null : _start, child: const Text('다음')),
      ],
    );
  }
}

/// 성인 확인. 휴대폰 인증과 별도 단계다.
/// 운영 환경에서는 본인확인 기관 화면으로 넘어가 그 결과를 서버가 직접 확인한다.
class AdultPage extends StatefulWidget {
  const AdultPage({super.key, required this.signupToken});
  final String signupToken;

  @override
  State<AdultPage> createState() => _AdultPageState();
}

class _AdultPageState extends State<AdultPage> {
  final _year = TextEditingController();
  bool _busy = false;

  Future<void> _verify() async {
    if (_busy) return;
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/auth/adult/verify', {'signupToken': widget.signupToken, 'devBirthYear': int.tryParse(_year.text)});
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SignupProfilePage(signupToken: widget.signupToken, ageBand: (res['ageBand'] ?? '') as String),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      showMessage(context, e.message);
      if (e.code == 'NOT_ADULT' || e.code == 'SIGNUP_EXPIRED') {
        Navigator.of(context).popUntil((r) => r.isFirst);
      }
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _StepScaffold(
      step: 2,
      title: '성인 확인',
      subtitle: '성인 회원만 이용할 수 있습니다. 생년월일은 연령대 표시에만 쓰이고 공개되지 않습니다.',
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Text('시험 환경에서는 본인확인 기관 대신 출생 연도 입력으로 확인합니다. 정식 서비스에서는 인증기관이 확인한 결과만 사용합니다.', style: Theme.of(context).textTheme.bodySmall),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _year,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
          decoration: const InputDecoration(labelText: '출생 연도', hintText: '1990'),
        ),
        const SizedBox(height: 12),
        FilledButton(onPressed: _busy ? null : _verify, child: const Text('확인')),
      ],
    );
  }
}

class SignupProfilePage extends StatefulWidget {
  const SignupProfilePage({super.key, required this.signupToken, required this.ageBand});
  final String signupToken;
  final String ageBand;

  @override
  State<SignupProfilePage> createState() => _SignupProfilePageState();
}

class _SignupProfilePageState extends State<SignupProfilePage> {
  final _form = ProfileFormData();
  bool _busy = false;
  String? _catalogError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadCatalog());
  }

  Future<void> _loadCatalog() async {
    try {
      await AppScope.read(context).loadCatalog();
      if (mounted) setState(() => _catalogError = null);
    } catch (e) {
      if (mounted) setState(() => _catalogError = e.toString());
    }
  }

  Future<void> _submit() async {
    final problem = _form.validate();
    if (problem != null) {
      showMessage(context, problem);
      return;
    }
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/v1/auth/signup', {'signupToken': widget.signupToken, ..._form.toJson()});
      await app.completeLogin(res['token'] as String);
    } on ApiException catch (e) {
      if (!mounted) return;
      showMessage(context, e.message);
      if (e.code == 'SIGNUP_EXPIRED') {
        Navigator.of(context).popUntil((r) => r.isFirst);
      }
    } on NetworkException catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return _StepScaffold(
      step: 3,
      title: '프로필 만들기',
      subtitle: '연령대는 성인 확인 결과로 "${widget.ageBand}"(으)로 표시됩니다. 나머지는 나중에 바꿀 수 있어요.',
      children: [
        if (_catalogError != null)
          StateView(
            icon: Icons.cloud_off_outlined,
            title: '지역 목록을 불러오지 못했어요',
            message: _catalogError,
            actions: [FilledButton(onPressed: _loadCatalog, child: const Text('다시 시도'))],
          )
        else if (app.regions.isEmpty)
          const Padding(
            padding: EdgeInsets.all(32),
            child: Center(child: CircularProgressIndicator()),
          )
        else ...[
          ProfileForm(data: _form, onChanged: () => setState(() {})),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _submit,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
            child: const Text('가입 완료하고 주변 둘러보기'),
          ),
        ],
      ],
    );
  }
}

/// 본인확인 사업자(포트원) 화면. 인증창에서 휴대폰 소유와 생년월일을 확인하면,
/// 서버가 결과를 직접 다시 조회해 휴대폰 확인 → 성인 확인을 차례로 기록한다.
class IdentityWebPage extends StatefulWidget {
  const IdentityWebPage({super.key});

  @override
  State<IdentityWebPage> createState() => _IdentityWebPageState();
}

class _IdentityWebPageState extends State<IdentityWebPage> {
  WebViewController? _web;
  String? _verificationId;
  String? _doneUrl;
  String? _error;
  bool _checking = false;
  int _progress = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  Future<void> _start() async {
    final app = AppScope.read(context);
    setState(() {
      _error = null;
      _web = null;
      _checking = false;
    });
    try {
      final res = await app.api.post('/v1/auth/identity/start');
      _verificationId = res['verificationId'] as String;
      _doneUrl = res['doneUrlPrefix'] as String;
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setNavigationDelegate(
          NavigationDelegate(
            onProgress: (p) {
              if (mounted) setState(() => _progress = p);
            },
            onNavigationRequest: (req) {
              if (_doneUrl != null && req.url.startsWith(_doneUrl!)) {
                _finish(Uri.parse(req.url));
                return NavigationDecision.prevent;
              }
              // 통신사 인증 앱(PASS 등)을 여는 앱 전용 주소는 웹뷰에서 열지 않는다.
              final scheme = Uri.tryParse(req.url)?.scheme ?? '';
              if (!['http', 'https', 'about', 'data', 'javascript'].contains(scheme)) return NavigationDecision.prevent;
              return NavigationDecision.navigate;
            },
            onPageStarted: (url) {
              if (_doneUrl != null && url.startsWith(_doneUrl!)) _finish(Uri.parse(url));
            },
          ),
        )
        ..loadRequest(Uri.parse(res['pageUrl'] as String));
      if (mounted) setState(() => _web = controller);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on NetworkException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _finish(Uri done) async {
    if (_checking) return;
    final code = done.queryParameters['code'];
    if (code != null && code.isNotEmpty) {
      // 사용자가 인증창을 닫았거나 인증에 실패한 경우
      final message = done.queryParameters['message'];
      setState(() => _error = message != null && message.isNotEmpty ? message : '본인인증을 완료하지 못했어요.');
      return;
    }
    final app = AppScope.read(context);
    setState(() => _checking = true);
    try {
      final res = await app.api.post('/v1/auth/identity/complete', {'verificationId': _verificationId});
      if (res['status'] == 'login') {
        await app.completeLogin(res['token'] as String);
        return;
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => SignupProfilePage(signupToken: res['signupToken'] as String, ageBand: (res['ageBand'] ?? '') as String),
        ),
      );
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _checking = false;
          _error = e.message;
        });
      }
    } on NetworkException catch (e) {
      if (mounted) {
        setState(() {
          _checking = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    Widget body;
    if (_error != null) {
      body = StateView(
        icon: Icons.verified_user_outlined,
        title: '본인인증을 마치지 못했어요',
        message: _error,
        actions: [
          FilledButton(onPressed: _start, child: const Text('다시 인증하기')),
          OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('처음으로')),
        ],
      );
    } else if (_checking || web == null) {
      body = const StateView.loading();
    } else {
      body = Column(
        children: [
          if (_progress < 100) LinearProgressIndicator(value: _progress / 100),
          Expanded(child: WebViewWidget(controller: web)),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('휴대폰 본인인증')),
      body: SafeArea(child: body),
    );
  }
}
