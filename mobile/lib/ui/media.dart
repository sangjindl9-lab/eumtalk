import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';

import 'widgets.dart';

/// 비공개 저장소의 사진. 서버가 권한을 확인한 뒤 내준 제한 시간 링크로만 불러온다.
class MediaImage extends StatefulWidget {
  const MediaImage({super.key, required this.mediaId, this.fit = BoxFit.cover, this.width, this.height});
  final String mediaId;
  final BoxFit fit;
  final double? width;
  final double? height;

  @override
  State<MediaImage> createState() => _MediaImageState();
}

class _MediaImageState extends State<MediaImage> {
  Future<String?>? _url;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _url ??= AppScope.read(context).mediaUrl(widget.mediaId);
  }

  @override
  void didUpdateWidget(MediaImage old) {
    super.didUpdateWidget(old);
    if (old.mediaId != widget.mediaId) _url = AppScope.read(context).mediaUrl(widget.mediaId);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Widget box(Widget child) =>
        Container(width: widget.width, height: widget.height, color: scheme.surfaceContainerHighest, alignment: Alignment.center, child: child);
    return FutureBuilder<String?>(
      future: _url,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return box(const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)));
        final url = snap.data;
        if (url == null) return box(Icon(Icons.broken_image_outlined, color: scheme.outline));
        return Image.network(
          url,
          fit: widget.fit,
          width: widget.width,
          height: widget.height,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => box(Icon(Icons.broken_image_outlined, color: scheme.outline)),
        );
      },
    );
  }
}

/// 사진 한 장을 골라 바이트로 돌려준다. 긴 변 2000px 이하로 줄여서 올린다(서버가 다시 검사·변환한다).
Future<Uint8List?> pickPhoto(BuildContext context) async {
  final source = await showModalBottomSheet<ImageSource>(
    context: context,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('앨범에서 고르기'), onTap: () => Navigator.of(sheet).pop(ImageSource.gallery)),
          ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('사진 찍기'), onTap: () => Navigator.of(sheet).pop(ImageSource.camera)),
        ],
      ),
    ),
  );
  if (source == null) return null;
  try {
    final file = await ImagePicker().pickImage(source: source, maxWidth: 2000, maxHeight: 2000, imageQuality: 88, requestFullMetadata: false);
    return file == null ? null : await file.readAsBytes();
  } catch (_) {
    if (context.mounted) showMessage(context, '사진을 불러오지 못했어요. 사진 접근 권한을 확인해 주세요.');
    return null;
  }
}

/// 사진을 크게 본다.
void openPhoto(BuildContext context, String mediaId) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          actions: [
            IconButton(
              icon: const Icon(Icons.flag_outlined),
              tooltip: '사진 신고',
              onPressed: () => showReportSheet(context, targetType: 'photo', targetId: mediaId),
            ),
          ],
        ),
        body: InteractiveViewer(
          child: Center(
            child: MediaImage(mediaId: mediaId, fit: BoxFit.contain),
          ),
        ),
      ),
    ),
  );
}
