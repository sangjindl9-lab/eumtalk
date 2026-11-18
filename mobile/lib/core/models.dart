/// 서버 응답 모델. 서버는 좌표·정밀 거리·전화번호를 내려주지 않으므로 여기에도 그런 필드가 없다.
library;

List<String> _strings(dynamic v) =>
    (v as List? ?? const []).map((e) => e.toString()).toList();

class PublicProfile {
  PublicProfile.fromJson(Map<String, dynamic> j)
    : userId = j['userId'] as String,
      nickname = (j['nickname'] ?? '') as String,
      ageBand = (j['ageBand'] ?? '') as String,
      gender = j['gender'] as String?,
      regionName = (j['regionName'] ?? '') as String,
      bio = (j['bio'] ?? '') as String,
      avatarColor = (j['avatarColor'] ?? 0) as int,
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
      interestIds = _strings(j['interestIds']),
      showInNearby = (j['settings']?['showInNearby'] ?? true) as bool,
      showLastActive = (j['settings']?['showLastActive'] ?? true) as bool,
      acceptGreetings = (j['settings']?['acceptGreetings'] ?? true) as bool,
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
  final bool locationShared;
}

class Region {
  Region.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      sido = j['sido'] as String,
      sigungu = j['sigungu'] as String,
      name = j['name'] as String;
  final String id;
  final String sido;
  final String sigungu;
  final String name;
}

class Interest {
  Interest.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      name = j['name'] as String;
  final String id;
  final String name;
}

class Greeting {
  Greeting.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      body = j['body'] as String,
      createdAt = DateTime.parse(j['createdAt'] as String).toLocal(),
      sender = PublicProfile.fromJson(j['sender'] as Map<String, dynamic>);
  final String id;
  final String body;
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
  Message({
    required this.id,
    required this.conversationId,
    required this.seq,
    required this.senderId,
    required this.clientMsgId,
    required this.kind,
    required this.body,
    required this.createdAt,
    this.replyToId,
  });

  factory Message.fromJson(Map<String, dynamic> j) => Message(
    id: j['id'] as String,
    conversationId: j['conversationId'] as String,
    seq: (j['seq'] as num).toInt(),
    senderId: j['senderId'] as String,
    clientMsgId: (j['clientMsgId'] ?? '') as String,
    kind: (j['kind'] ?? 'text') as String,
    body: (j['body'] ?? '') as String,
    replyToId: j['replyToId'] as String?,
    createdAt: DateTime.parse(j['createdAt'] as String).toLocal(),
  );

  final String id;
  final String conversationId;
  final int seq;
  final String senderId;
  final String clientMsgId;
  final String kind;
  final String body;
  final String? replyToId;
  final DateTime createdAt;
}

class Conversation {
  Conversation.fromJson(Map<String, dynamic> j)
    : id = j['id'] as String,
      peerId = j['peer']['userId'] as String,
      peerNickname = (j['peer']['nickname'] ?? '') as String,
      peerColor = (j['peer']['avatarColor'] ?? 0) as int,
      peerActive = (j['peer']['active'] ?? true) as bool,
      lastSeq = (j['lastSeq'] as num).toInt(),
      lastReadSeq = (j['lastReadSeq'] as num).toInt(),
      peerReadSeq = (j['peerReadSeq'] as num).toInt(),
      unreadCount = (j['unreadCount'] as num).toInt(),
      canSend = (j['canSend'] ?? true) as bool,
      blockedByMe = (j['blockedByMe'] ?? false) as bool,
      lastBody = j['lastMessage']?['body'] as String?,
      lastSenderId = j['lastMessage']?['senderId'] as String?,
      updatedAt = DateTime.parse(j['updatedAt'] as String).toLocal();

  final String id;
  final String peerId;
  final String peerNickname;
  final int peerColor;
  final bool peerActive;
  int lastSeq;
  int lastReadSeq;
  int peerReadSeq;
  int unreadCount;
  bool canSend;
  bool blockedByMe;
  String? lastBody;
  String? lastSenderId;
  DateTime updatedAt;
}

/// 아직 서버 확인을 받지 못한 내 메시지. 기기에 저장되어 앱을 껐다 켜도 남는다.
enum PendingState { sending, queued, failed }

class PendingMessage {
  PendingMessage({
    required this.conversationId,
    required this.clientMsgId,
    required this.text,
    required this.createdAt,
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
