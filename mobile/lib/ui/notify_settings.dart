import 'package:geolocator/geolocator.dart';
import 'package:material_ui/material_ui.dart';

import '../core/models.dart';
import '../core/push.dart';
import 'widgets.dart';

/// 알림 설정: 전체 켜기/끄기, 종류별 켜기/끄기, 방해 금지 시간, 잠금화면 미리보기.
/// 서버가 이 설정을 지켜서 보내므로 다른 기기에서 로그인해도 그대로 적용된다.
class NotificationSettingsPage extends StatefulWidget {
  const NotificationSettingsPage({super.key});

  @override
  State<NotificationSettingsPage> createState() => _NotificationSettingsPageState();
}

class _NotificationSettingsPageState extends State<NotificationSettingsPage> {
  bool? _blocked;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkSystem());
  }

  Future<void> _checkSystem() async {
    final b = await AppScope.read(context).push.blockedBySystem();
    if (mounted) setState(() => _blocked = b);
  }

  Future<void> _patch(Map<String, dynamic> patch) async {
    if (_busy) return;
    setState(() => _busy = true);
    final app = AppScope.read(context);
    try {
      await app.updateMe({'notify': patch});
      if (patch['all'] == true) {
        await app.push.ensureRegistered(app.api);
        await _checkSystem();
      }
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _preview(bool v) async {
    try {
      await AppScope.read(context).updateMe({
        'settings': {'pushPreview': v},
      });
    } catch (e) {
      if (mounted) showMessage(context, e.toString());
    }
  }

  Future<void> _pickTime(String key, String current) async {
    final parts = current.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])),
      helpText: key == 'quietStart' ? '방해 금지 시작' : '방해 금지 끝',
    );
    if (picked == null) return;
    final v = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    await _patch({key: v});
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me;
    final t = Theme.of(context);
    if (me == null) return const Scaffold(body: SizedBox.shrink());
    final NotifyPrefs n = me.notify;
    Widget kind(String key, String title, String subtitle, bool value) => SwitchListTile(
      title: Text(title),
      subtitle: Text(subtitle),
      value: n.all && value,
      onChanged: n.all && !_busy ? (v) => _patch({key: v}) : null,
    );

    return Scaffold(
      appBar: AppBar(title: const Text('알림 설정')),
      body: ContentWidth(
        child: ListView(
          children: [
            if (!PushService.configured)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: ListTile(
                  leading: const Icon(Icons.info_outline),
                  title: const Text('이 버전은 휴대폰 알림 발송이 아직 준비되지 않았어요'),
                  subtitle: const Text('설정은 저장되고, 알림 서비스가 연결되면 바로 적용됩니다. 앱을 켜 두었을 때는 새 메시지가 바로 보입니다.'),
                ),
              )
            else if (_blocked == true && n.all)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: ListTile(
                  leading: const Icon(Icons.notifications_off_outlined),
                  title: const Text('휴대폰 설정에서 이 앱의 알림이 꺼져 있어요'),
                  subtitle: const Text('알림을 받으려면 휴대폰 설정에서 이음톡 알림을 허용해 주세요.'),
                  trailing: TextButton(onPressed: Geolocator.openAppSettings, child: const Text('설정 열기')),
                ),
              ),
            SwitchListTile(
              title: Text('알림 받기', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              subtitle: Text(n.all ? '아래에서 고른 알림만 받습니다.' : '모든 알림을 받지 않습니다. 앱을 열면 새 소식은 그대로 보입니다.'),
              value: n.all,
              onChanged: _busy ? null : (v) => _patch({'all': v}),
            ),
            const Divider(),
            _Header('받을 알림'),
            kind('direct', '1대1 메시지', '대화방별로는 대화방 메뉴의 "알림 끄기"로 따로 끌 수 있어요.', n.direct),
            kind('greeting', '인사 요청', '새 인사를 받았을 때', n.greeting),
            kind('room', '모임방 메시지', '참여한 모임방의 새 메시지', n.room),
            kind('comment', '내 글의 댓글', '동네 게시판·장터에 쓴 글에 댓글이 달렸을 때', n.comment),
            kind('notice', '운영 알림', '신고 처리 결과, 문의 답변, 이용 조치 안내', n.notice),
            const Divider(),
            _Header('방해 금지 시간'),
            SwitchListTile(
              title: const Text('방해 금지 시간 사용'),
              subtitle: Text('이 시간에는 휴대폰 알림을 보내지 않습니다. (${n.quietStart} ~ ${n.quietEnd})'),
              value: n.all && n.quiet,
              onChanged: n.all && !_busy ? (v) => _patch({'quiet': v}) : null,
            ),
            ListTile(
              enabled: n.all && n.quiet && !_busy,
              title: const Text('시작'),
              trailing: Text(n.quietStart, style: t.textTheme.titleMedium),
              onTap: () => _pickTime('quietStart', n.quietStart),
            ),
            ListTile(
              enabled: n.all && n.quiet && !_busy,
              title: const Text('끝'),
              trailing: Text(n.quietEnd, style: t.textTheme.titleMedium),
              onTap: () => _pickTime('quietEnd', n.quietEnd),
            ),
            const Divider(),
            _Header('잠금화면'),
            SwitchListTile(
              title: const Text('알림에 내용 표시'),
              subtitle: const Text('끄면 잠금화면 알림에 "새 메시지가 도착했습니다"만 보입니다.'),
              value: me.pushPreview,
              onChanged: n.all ? _preview : null,
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(text, style: t.textTheme.titleSmall?.copyWith(color: t.colorScheme.primary)),
    );
  }
}
