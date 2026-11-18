import 'package:material_ui/material_ui.dart';

import '../core/models.dart';
import 'widgets.dart';

/// 가입과 프로필 수정이 함께 쓰는 입력값.
class ProfileFormData {
  ProfileFormData();

  ProfileFormData.fromMe(Me me)
    : nickname = me.nickname,
      bio = me.bio,
      gender = me.gender,
      genderPublic = me.genderPublic,
      regionId = me.regionId,
      regionName = me.regionName,
      interestIds = me.interestIds.toSet();

  String nickname = '';
  String bio = '';
  String? gender;
  bool genderPublic = false;
  String? regionId;
  String? regionName;
  Set<String> interestIds = {};

  String? validate() {
    final n = nickname.trim();
    if (!RegExp(r'^[가-힣a-zA-Z0-9_]{2,12}$').hasMatch(n)) {
      return '닉네임은 한글·영문·숫자·밑줄 2~12자로 입력해 주세요.';
    }
    if (regionId == null) return '활동 지역을 선택해 주세요.';
    return null;
  }

  Map<String, dynamic> toJson() => {
    'nickname': nickname.trim(),
    'bio': bio.trim(),
    'gender': gender,
    'genderPublic': genderPublic,
    'regionId': regionId,
    'interestIds': interestIds.toList(),
  };
}

class ProfileForm extends StatefulWidget {
  const ProfileForm({super.key, required this.data, required this.onChanged});
  final ProfileFormData data;
  final VoidCallback onChanged;

  @override
  State<ProfileForm> createState() => _ProfileFormState();
}

class _ProfileFormState extends State<ProfileForm> {
  late final TextEditingController _nickname = TextEditingController(
    text: widget.data.nickname,
  );
  late final TextEditingController _bio = TextEditingController(
    text: widget.data.bio,
  );

  @override
  void dispose() {
    _nickname.dispose();
    _bio.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final d = widget.data;
    final t = Theme.of(context);
    Widget label(String text, [String? hint]) => Padding(
      padding: const EdgeInsets.only(top: 20, bottom: 8),
      child: Row(
        children: [
          Text(text, style: t.textTheme.titleSmall),
          if (hint != null) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                hint,
                style: t.textTheme.bodySmall?.copyWith(
                  color: t.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ],
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Avatar(name: d.nickname, colorIndex: d.nickname.length, size: 64),
            const SizedBox(width: 14),
            Expanded(
              child: Text(
                '프로필 사진 등록은 다음 업데이트(사진 단계)에서 열립니다.',
                style: t.textTheme.bodySmall,
              ),
            ),
          ],
        ),
        label('닉네임'),
        TextField(
          controller: _nickname,
          maxLength: 12,
          decoration: const InputDecoration(hintText: '한글·영문·숫자 2~12자'),
          onChanged: (v) {
            d.nickname = v;
            widget.onChanged();
          },
        ),
        label('활동 지역', '위치 권한 없이 직접 고를 수 있어요'),
        OutlinedButton.icon(
          onPressed: () async {
            final r = await pickRegion(context);
            if (r != null) {
              d.regionId = r.id;
              d.regionName = r.name;
              widget.onChanged();
            }
          },
          icon: const Icon(Icons.place_outlined),
          label: Text(d.regionName ?? '시·군·구 선택'),
        ),
        label('성별', '선택 입력'),
        Wrap(
          spacing: 8,
          children: [
            for (final e in const {
              'male': '남성',
              'female': '여성',
              'other': '기타',
            }.entries)
              ChoiceChip(
                label: Text(e.value),
                selected: d.gender == e.key,
                onSelected: (on) {
                  d.gender = on ? e.key : null;
                  if (!on) d.genderPublic = false;
                  widget.onChanged();
                },
              ),
          ],
        ),
        if (d.gender != null)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('프로필에 성별 표시'),
            value: d.genderPublic,
            onChanged: (v) {
              d.genderPublic = v;
              widget.onChanged();
            },
          ),
        label('관심사', '최대 10개'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final i in app.interests)
              FilterChip(
                label: Text(i.name),
                selected: d.interestIds.contains(i.id),
                onSelected: (on) {
                  if (on && d.interestIds.length >= 10) {
                    showMessage(context, '관심사는 10개까지 고를 수 있어요.');
                    return;
                  }
                  if (on) {
                    d.interestIds.add(i.id);
                  } else {
                    d.interestIds.remove(i.id);
                  }
                  widget.onChanged();
                },
              ),
          ],
        ),
        label('자기소개'),
        TextField(
          controller: _bio,
          maxLength: 300,
          minLines: 3,
          maxLines: 6,
          decoration: const InputDecoration(
            hintText: '어떤 이야기를 나누고 싶은지 적어 보세요. 연락처는 적지 마세요.',
          ),
          onChanged: (v) => d.bio = v,
        ),
      ],
    );
  }
}
