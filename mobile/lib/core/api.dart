import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// 서버가 돌려준 오류. [message]는 그대로 화면에 보여줄 수 있는 한국어 문장이다.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  @override
  String toString() => message;
}

/// 서버에 닿지 못한 경우(오프라인·시간 초과). 재시도 대상이다.
class NetworkException implements Exception {
  @override
  String toString() => '인터넷 연결을 확인해 주세요.';
}

class ApiClient {
  ApiClient(this.baseUrl, {this.token, this.onUnauthorized});

  String baseUrl;
  String? token;
  void Function()? onUnauthorized;
  final http.Client _http = http.Client();

  static String get platformName => Platform.isIOS ? 'ios' : 'android';

  Uri _uri(String path, [Map<String, String>? query]) {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final uri = Uri.parse('$base$path');
    if (query == null || query.isEmpty) return uri;
    return uri.replace(queryParameters: query);
  }

  Uri get wsUri {
    final u = _uri('/v1/ws');
    return u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws');
  }

  Map<String, String> get _headers => {'content-type': 'application/json', 'x-platform': platformName, if (token != null) 'authorization': 'Bearer $token'};

  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) => _send('GET', path, query: query);
  Future<Map<String, dynamic>> post(String path, [Object? body]) => _send('POST', path, body: body);
  Future<Map<String, dynamic>> patch(String path, Object body) => _send('PATCH', path, body: body);
  Future<Map<String, dynamic>> put(String path, Object body) => _send('PUT', path, body: body);
  Future<Map<String, dynamic>> delete(String path, [Object? body]) => _send('DELETE', path, body: body);

  /// 사진 업로드: 본문에 이미지 바이트를 그대로 보낸다.
  Future<Map<String, dynamic>> postBytes(String path, Uint8List bytes, {Map<String, String>? query}) => _send('POST', path, query: query, bytes: bytes);

  Future<Map<String, dynamic>> _send(String method, String path, {Map<String, String>? query, Object? body, Uint8List? bytes}) async {
    http.Response res;
    try {
      final req = http.Request(method, _uri(path, query));
      req.headers.addAll(_headers);
      if (bytes != null) {
        req.headers['content-type'] = 'image/jpeg';
        req.bodyBytes = bytes;
      } else if (body != null) {
        req.body = jsonEncode(body);
      }
      res = await http.Response.fromStream(await _http.send(req).timeout(Duration(seconds: bytes != null ? 60 : 15)));
    } on TimeoutException {
      throw NetworkException();
    } on SocketException {
      throw NetworkException();
    } on http.ClientException {
      throw NetworkException();
    } on HandshakeException {
      throw NetworkException();
    }

    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {
      // 본문이 JSON이 아닌 경우(게이트웨이 오류 등)
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final gatewayDown = res.statusCode == 502 || res.statusCode == 504 || (res.statusCode == 503 && json['error'] == null);
    if (gatewayDown) {
      throw NetworkException();
    }
    final err = json['error'];
    final code = err is Map ? (err['code'] ?? 'ERROR').toString() : 'ERROR';
    final message = err is Map ? (err['message'] ?? '요청을 처리할 수 없습니다.').toString() : '요청을 처리할 수 없습니다.';
    if (res.statusCode == 401 && token != null) onUnauthorized?.call();
    throw ApiException(res.statusCode, code, message);
  }
}
