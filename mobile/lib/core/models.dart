/// 서버 응답 모델. 서버는 좌표·정밀 거리·전화번호를 내려주지 않으므로 여기에도 그런 필드가 없다.
library;

List<String> _strings(dynamic v) => (v as List? ?? const []).map((e) => e.toString()).toList();

class PublicProfile {
  PublicProfile.fromJson(Map<String, dynamic> j)
    : userId = j['userId'] as String,
      nickname = (j['nickname'] ?? '') as String,
      ageBand = (j['ageBand'] ?? '') as String,
      gender = j['gender'] as String?,
      regionName = (j['regionName'] ?? '') as String,
      bio = (j['bio'] ?? '') as String,
      avatarColor = (j['avatarColor'] ?? 0) as int,
      photoMediaId = j['photoMediaId'] as String?,
      interests = _strings(j['interests']),
      commonInterests = _strings(j['commonInterests']),
      proximity = (j['proximity'] ?? 'far') as String,
      activity = j['activity'] as String?,
      acceptsGreetings = (j['acceptsGreetings'] ?? true) as bool;

  final String userId;
  final String nickname;
  final String ageBand;
  final String? gender;
  final String regionName;
  final String bio;
  final int avatarColor;
  final String? photoMediaId;
  final List<String> interests;
  final List<String> commonInterests;
  final String proximity;
  final String? activity;
  final bool acceptsGreetings;

  /// 거리는 넓은 범위 문구로만 보여준다.
  String get proximityLabel {
    switch (proximity) {
      case 'same_neighborhood':
        return '같은 동네';
      case 'nearby':
        return '가까운 지역';
      case 'same_region':
        return '같은 지역';
      case 'same_province':
        return '같은 시·도';
      case 'visiting':
        return '이 지역 둘러보는 중';
      default:
        return regionName;
    }
  }

  String? get activityLabel {
    switch (activity) {
      case 'now':
        return '방금 활동';
      case 'today':
        return '오늘 활동';
      case 'week':
        return '이번 주 활동';
      default:
        return null;
    }
  }

  String? get genderLabel {
    switch (gender) {
      case 'male':
        return '남성';
      case 'female':
        return '여성';
      case 'other':
        return '기타';
      default:
        return null;
    }
  }
}

/// 알림 설정. 서버가 종류별 켜기/끄기와 방해 금지 시간(한국 시각)을 지켜서 보낸다.
class NotifyPrefs {
  NotifyPrefs.fromJson(Map<String, dynamic> j)
    : all = (j['all'] ?? true) as bool,
      direct = (j['direct'] ?? true) as bool,
      greeting = (j['greeting'] ?? true) as bool,
      room = (j['room'] ?? true) as bool,
      comment = (j['comment'] ?? true) as bool,
      notice = (j['notice'] ?? true) as bool,
      quiet = (j['quiet'] ?? false) as bool,
      quietStart = (j['quietStart'] ?? '23:00') as String,
      quietEnd = (j['quietEnd'] ?? '08:00') as String;

  final bool all;
  final bool direct;
  final bool greeting;
  final bool room;
  final bool comment;
  final bool notice;
  final bool quiet;
  final String quietStart;
  final String quietEnd;
}

class Me {
  Me.fromJson(Map<String, dynamic> j)
    : userId = j['userId'] as String,
      nickname = j['nickname'] as String,
      ageBand = j['ageBand'] as String,
      gender = j['gender'] as String?,
      genderPublic = (j['genderPublic'] ?? false) as bool,
      regionId = j['regionId'] as String,
      regionName = j['regionName'] as String,
      bio = (j['bio'] ?? '') as String,
      avatarColor = (j['avatarColor'] ?? 0) as int,
      photoMediaId = j['photoMediaId'] as String?,
      interestIds = _strings(j['interestIds']),
      showInNearby = (j['settings']?['showInNearby'] ?? true) as bool,
      showLastActive = (j['settings']?['showLastActive'] ?? true) as bool,
      acceptGreetings = (j['settings']?['acceptGreetings'] ?? true) as bool,
      pushPreview = (j['settings']?['pushPreview'] ?? true) as bool,
      notify = NotifyPrefs.fromJson((j['notify'] as Map?)?.cast<String, dynamic>() ?? const {}),
      browse = (j['browse'] as Map?)?.cast<String, dynamic>(),
      status = (j['status'] ?? 'active') as String,
      locationShared = (j['locationShared'] ?? false) as bool;

  final String userId;
  final String nickname;
  final String ageBand;
  final String? gender;
  final bool genderPublic;
  final String regionId;
  final String regionName;
  final String bio;
  final int avatarColor;
  final List<String> interestIds;
  final bool showInNearby;
  final bool showLastActive;
  final bool acceptGreetings;
  final bool pushPreview;
  final NotifyPrefs notify;
  final String? photoMediaId;

  /// 다른 지역 둘러보기 이용 중이면 {regionId, regionName, until}
  final Map<String, dynamic>? browse;
  final String status;
  final bool locationShared;

  bool get suspended => status == 'suspended';
}

class Region {
  Region.fromJson(Map<String, dynamic> j) : id = j['id'] as String, sido = j['sido'] as String, sigungu = j['sigungu'] as String, name = j['name'] as String;
  final String id;
  final String sido;
  final String sigungu;
  final String name;
}

class Interest {
  Interest.fromJson(Map<String, dynamic> j) : id = j['id'] as String, name = j['name'] as String;
  final String id;
  final String name;
}

class Greeting {
  Greeting.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      body = j['body'] as String,
      context = (j['context'] as Map?)?.cast<String, dynamic>(),
      createdAt = DateTime.parse(j['createdAt'] as String).toLocal(),
      sender = PublicProfile.fromJson(j['sender'] as Map<String, dynamic>);
  final String id;
  final String body;

  /// 장터 거래 문의면 {title, price, thumbMediaId, postId}
  final Map<String, dynamic>? context;
  final DateTime createdAt;
  final PublicProfile sender;
}

class SentGreeting {
  SentGreeting.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      body = j['body'] as String,
      status = j['status'] as String,
      conversationId = j['conversationId'] as String?,
      createdAt = DateTime.parse(j['createdAt'] as String).toLocal(),
      receiverNickname = (j['receiver']?['nickname'] ?? '') as String,
      receiverColor = (j['receiver']?['avatarColor'] ?? 0) as int;
  final String id;
  final String body;
  final String status;
  final String? conversationId;
  final DateTime createdAt;
  final String receiverNickname;
  final int receiverColor;
}

class Message {
  Message.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      conversationId = j['conversationId'] as String,
      seq = (j['seq'] as num).toInt(),
      senderId = j['senderId'] as String,
      senderNickname = (j['senderNickname'] ?? '') as String,
      senderColor = (j['senderColor'] ?? 0) as int,
      clientMsgId = (j['clientMsgId'] ?? '') as String,
      kind = (j['kind'] ?? 'text') as String,
      body = (j['body'] ?? '') as String,
      mediaId = j['mediaId'] as String?,
      meta = (j['meta'] as Map?)?.cast<String, dynamic>(),
      replyToId = j['replyToId'] as String?,
      hidden = (j['hidden'] ?? false) as bool,
      masked = (j['masked'] ?? false) as bool,
      createdAt = DateTime.parse(j['createdAt'] as String).toLocal();

  final String id;
  final String conversationId;
  final int seq;
  final String senderId;
  final String senderNickname;
  final int senderColor;
  final String clientMsgId;
  final String kind;
  String body;
  String? mediaId;
  final Map<String, dynamic>? meta;
  final String? replyToId;

  /// 운영 조치로 숨겨진 메시지
  bool hidden;

  /// 그룹방에서 내가 차단한 회원의 메시지(내용이 오지 않는다)
  final bool masked;
  final DateTime createdAt;

  bool get isSystem => kind == 'system';
  bool get isImage => kind == 'image' && mediaId != null;

  /// 거래 문의로 시작된 메시지면 상품 정보
  Map<String, dynamic>? get marketContext => (meta?['context'] as Map?)?.cast<String, dynamic>();

  String get preview => hidden
      ? '숨겨진 메시지'
      : masked
      ? '차단한 회원의 메시지'
      : kind == 'image'
      ? '사진'
      : body;
}

class Conversation {
  Conversation.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      isGroup = j['type'] == 'group',
      title = (j['title'] ?? '') as String,
      peerId = (j['peer']?['userId'] ?? '') as String,
      peerColor = (j['peer']?['avatarColor'] ?? 0) as int,
      peerPhoto = j['peer']?['photoMediaId'] as String?,
      peerActive = (j['peer']?['active'] ?? true) as bool,
      roomRole = j['room']?['role'] as String?,
      roomImage = j['room']?['imageMediaId'] as String?,
      memberCount = ((j['room']?['memberCount'] ?? 0) as num).toInt(),
      capacity = ((j['room']?['capacity'] ?? 0) as num).toInt(),
      lastSeq = (j['lastSeq'] as num).toInt(),
      lastReadSeq = (j['lastReadSeq'] as num).toInt(),
      peerReadSeq = (j['peerReadSeq'] as num).toInt(),
      unreadCount = (j['unreadCount'] as num).toInt(),
      muted = (j['muted'] ?? false) as bool,
      canSend = (j['canSend'] ?? true) as bool,
      blockedByMe = (j['blockedByMe'] ?? false) as bool,
      lastBody = j['lastMessage']?['body'] as String?,
      lastSenderId = j['lastMessage']?['senderId'] as String?,
      updatedAt = DateTime.parse(j['updatedAt'] as String).toLocal();

  final String id;
  final bool isGroup;
  final String title;
  final String peerId;
  final int peerColor;
  final String? peerPhoto;
  final bool peerActive;
  final String? roomRole;
  final String? roomImage;
  final int memberCount;
  final int capacity;
  int lastSeq;
  int lastReadSeq;
  int peerReadSeq;
  int unreadCount;
  bool muted;
  bool canSend;
  bool blockedByMe;
  String? lastBody;
  String? lastSenderId;
  DateTime updatedAt;

  String get peerNickname => title;
  bool get isStaff => roomRole == 'owner' || roomRole == 'manager';
}

/// 아직 서버 확인을 받지 못한 내 메시지. 기기에 저장되어 앱을 껐다 켜도 남는다.
enum PendingState { sending, queued, failed }

class PendingMessage {
  PendingMessage({
    required this.conversationId,
    required this.clientMsgId,
    required this.text,
    required this.createdAt,
    this.replyToId,
    this.state = PendingState.queued,
    this.error,
  });

  factory PendingMessage.fromJson(Map<String, dynamic> j) => PendingMessage(
    conversationId: j['conversationId'] as String,
    clientMsgId: j['clientMsgId'] as String,
    text: j['text'] as String,
    createdAt: DateTime.parse(j['createdAt'] as String),
    state: j['state'] == 'failed' ? PendingState.failed : PendingState.queued,
    error: j['error'] as String?,
  );

  final String conversationId;
  final String clientMsgId;
  final String text;
  final DateTime createdAt;
  final String? replyToId;
  PendingState state;
  String? error;

  Map<String, dynamic> toJson() => {
    'conversationId': conversationId,
    'clientMsgId': clientMsgId,
    'text': text,
    'createdAt': createdAt.toIso8601String(),
    'state': state == PendingState.failed ? 'failed' : 'queued',
    if (error != null) 'error': error,
  };
}
