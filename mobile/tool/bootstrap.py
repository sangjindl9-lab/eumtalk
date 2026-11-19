#!/usr/bin/env python3
"""
모바일 프로젝트 준비 스크립트 (여러 번 실행해도 안전).

  cd mobile && python3 tool/bootstrap.py

하는 일
 1. brand/brand.json → mobile/assets/brand.json 복사 (앱 이름·색상·운영사 정보의 단일 출처)
 2. android/, ios/ 폴더가 없으면 `flutter create` 로 현재 Flutter 버전에 맞게 생성
 3. Android 권한(인터넷, 대략적 위치)·앱 이름, iOS 표시 이름·위치 사용 문구 반영
 4. brand/icon.png 로 런처 아이콘 교체 (Pillow 가 설치된 경우)
"""
import json
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
ROOT = MOBILE.parent
brand = json.loads((ROOT / "brand" / "brand.json").read_text(encoding="utf-8"))
app_name = brand["appName"]
app_id = brand.get("androidApplicationId", "kr.eumsoft.eumtalk")
org = ".".join(app_id.split(".")[:-1])
LOCATION_REASON = "내 주변 회원을 찾을 때 대략적인 위치를 사용합니다. 정확한 위치는 다른 회원에게 공개되지 않습니다."


def step(msg):
    print(f"[bootstrap] {msg}")


shutil.copyfile(ROOT / "brand" / "brand.json", MOBILE / "assets" / "brand.json")
step("brand.json 동기화")

if not (MOBILE / "android").exists() or not (MOBILE / "ios").exists():
    step("플랫폼 폴더 생성 (flutter create)")
    flutter = shutil.which("flutter") or "flutter"
    subprocess.run(
        [flutter, "create", "--platforms=android,ios", "--org", org, "--project-name", "eumtalk", "--no-pub", "."],
        cwd=MOBILE,
        check=True,
    )
    # flutter create 가 만드는 기본 위젯 테스트는 이 앱과 맞지 않으므로 지운다.
    default_test = MOBILE / "test" / "widget_test.dart"
    if default_test.exists():
        default_test.unlink()

# ── Android ──────────────────────────────────────────────────────────────
manifest = MOBILE / "android/app/src/main/AndroidManifest.xml"
if manifest.exists():
    xml = manifest.read_text(encoding="utf-8")
    for perm in ("android.permission.INTERNET", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.POST_NOTIFICATIONS"):
        if perm not in xml:
            xml = xml.replace("<application", f'<uses-permission android:name="{perm}"/>\n    <application', 1)
    xml = re.sub(r'android:label="[^"]*"', f'android:label="{app_name}"', xml, count=1)
    manifest.write_text(xml, encoding="utf-8")
    step("AndroidManifest: 권한·앱 이름 반영 (위치는 대략적 위치 권한만 사용)")

# 개발 중 PC의 http://서버에 붙을 수 있도록 debug 빌드에서만 평문 통신을 허용한다.
debug_manifest = MOBILE / "android/app/src/debug/AndroidManifest.xml"
if debug_manifest.exists():
    xml = debug_manifest.read_text(encoding="utf-8")
    if "usesCleartextTraffic" not in xml:
        xml = xml.replace("</manifest>", '    <application android:usesCleartextTraffic="true"/>\n</manifest>')
        debug_manifest.write_text(xml, encoding="utf-8")
        step("debug 빌드 평문(http) 통신 허용")

# 일부 플러그인(image_picker_android 등)에서 release 빌드의 lintVital 작업이 lint 도구 자체 오류로 죽는 경우가 있다.
# 앱 동작과 무관한 검사이므로 꺼 둔다. (Groovy·Kotlin DSL 양쪽에서 같은 문법으로 동작)
LINT_BLOCK = """
// eumtalk: lintVital 비활성화 (tool/bootstrap.py 가 추가)
allprojects {
    tasks.matching { it.name.startsWith("lintVital") }.configureEach { enabled = false }
}
"""
for name in ("android/build.gradle.kts", "android/build.gradle"):
    gradle = MOBILE / name
    if gradle.exists():
        text = gradle.read_text(encoding="utf-8")
        if "eumtalk: lintVital" not in text:
            gradle.write_text(text.rstrip() + "\n" + LINT_BLOCK, encoding="utf-8")
            step(f"{name}: release lintVital 작업 비활성화")
        break

# ── Android 서명·최소 버전 ─────────────────────────────────────────────
# android/key.properties 가 있으면 release 빌드(APK·AAB)를 그 업로드 키로 서명하고, 없으면 디버그 키로 서명한다.
#   storeFile=/절대/경로/upload.jks
#   storePassword=...
#   keyAlias=upload
#   keyPassword=...
app_gradle = MOBILE / "android/app/build.gradle.kts"
if app_gradle.exists():
    g = app_gradle.read_text(encoding="utf-8")
    if "eumReleaseProps" not in g:
        # Kotlin DSL 에서 java 는 확장 이름과 겹치므로 import 로 가져온다(import 는 파일 맨 위에 있어야 한다).
        g = "import java.util.Properties\n" + g
        g = g.replace("android {", """// eumtalk: 업로드 키 서명 설정 (tool/bootstrap.py 가 추가)
val eumReleaseProps = Properties()
rootProject.file("key.properties").let { f -> if (f.exists()) f.inputStream().use { s -> eumReleaseProps.load(s) } }

android {""", 1)
        g = g.replace("    buildTypes {", """    signingConfigs {
        create("eumRelease") {
            if (!eumReleaseProps.isEmpty()) {
                storeFile = file(eumReleaseProps.getProperty("storeFile")!!)
                storePassword = eumReleaseProps.getProperty("storePassword")
                keyAlias = eumReleaseProps.getProperty("keyAlias")
                keyPassword = eumReleaseProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {""", 1)
        g = g.replace('signingConfig = signingConfigs.getByName("debug")',
                      'signingConfig = if (eumReleaseProps.isEmpty()) signingConfigs.getByName("debug") else signingConfigs.getByName("eumRelease")', 1)
        # Firebase(FCM) 안드로이드 SDK는 minSdk 24 이상이 필요하다.
        g = g.replace("minSdk = flutter.minSdkVersion", "minSdk = maxOf(flutter.minSdkVersion, 24)", 1)
        app_gradle.write_text(g, encoding="utf-8")
        step("app/build.gradle.kts: 업로드 키 서명(key.properties)·minSdk 24 반영")
    g = app_gradle.read_text(encoding="utf-8")
    if "com.google.android.play:app-update" not in g:
        # Play 인앱 업데이트 정보(새 버전 여부) 조회용
        g = g.rstrip() + '\n\ndependencies {\n    implementation("com.google.android.play:app-update:2.1.0")\n}\n'
        app_gradle.write_text(g, encoding="utf-8")
        step("app/build.gradle.kts: Play 인앱 업데이트 라이브러리 추가")

# ── iOS ──────────────────────────────────────────────────────────────────
plist_path = MOBILE / "ios/Runner/Info.plist"
if plist_path.exists():
    with plist_path.open("rb") as f:
        plist = plistlib.load(f)
    plist["CFBundleDisplayName"] = app_name
    plist["NSLocationWhenInUseUsageDescription"] = LOCATION_REASON
    plist["NSPhotoLibraryUsageDescription"] = "프로필·대화·게시글에 올릴 사진을 고를 때 사용합니다."
    plist["NSCameraUsageDescription"] = "프로필·대화·게시글에 올릴 사진을 찍을 때 사용합니다."
    modes = plist.get("UIBackgroundModes", [])
    if "remote-notification" not in modes:
        plist["UIBackgroundModes"] = modes + ["remote-notification"]
    with plist_path.open("wb") as f:
        plistlib.dump(plist, f)
    step("Info.plist: 표시 이름·위치·사진·알림 설정 반영")

# 푸시 알림(APNs) 권한 파일과 iOS 최소 버전(Firebase iOS SDK 기준 15.0)
ent = MOBILE / "ios/Runner/Runner.entitlements"
pbx = MOBILE / "ios/Runner.xcodeproj/project.pbxproj"
if pbx.exists():
    if not ent.exists():
        with ent.open("wb") as f:
            plistlib.dump({"aps-environment": "development"}, f)
    text = pbx.read_text(encoding="utf-8")
    if "CODE_SIGN_ENTITLEMENTS" not in text:
        text = text.replace("INFOPLIST_FILE = Runner/Info.plist;", "CODE_SIGN_ENTITLEMENTS = Runner/Runner.entitlements;\n\t\t\t\tINFOPLIST_FILE = Runner/Info.plist;")
    text = re.sub(r"IPHONEOS_DEPLOYMENT_TARGET = 1[0-4]\.0;", "IPHONEOS_DEPLOYMENT_TARGET = 15.0;", text)
    pbx.write_text(text, encoding="utf-8")
    podfile = MOBILE / "ios/Podfile"
    if podfile.exists():
        pf = podfile.read_text(encoding="utf-8")
        pf = re.sub(r"^#?\s*platform :ios, '[0-9.]+'", "platform :ios, '15.0'", pf, count=1, flags=re.M)
        podfile.write_text(pf, encoding="utf-8")
    step("iOS: 푸시 권한(entitlements)·최소 버전 15.0 반영 — 배포용은 aps-environment 를 production 으로 바꾼다")

# ── 아이콘 ────────────────────────────────────────────────────────────────
icon = ROOT / "brand" / "icon.png"
try:
    from PIL import Image  # type: ignore
except ImportError:
    Image = None
if Image is None:
    step("Pillow 가 없어 아이콘 교체는 건너뜀 (pip install pillow 후 다시 실행)")
elif icon.exists():
    src = Image.open(icon).convert("RGBA")
    targets = list((MOBILE / "android/app/src/main/res").glob("mipmap-*/ic_launcher.png"))
    targets += list((MOBILE / "ios/Runner/Assets.xcassets/AppIcon.appiconset").glob("*.png"))
    for t in targets:
        size = Image.open(t).size
        out = src.resize(size, Image.LANCZOS)
        if "appiconset" in str(t):  # iOS 아이콘은 투명 영역을 허용하지 않는다.
            bg = Image.new("RGB", size, brand.get("seedColor", "#2F6B5E"))
            bg.paste(out, mask=out.split()[3])
            out = bg
        out.save(t)
    step(f"런처 아이콘 {len(targets)}개 교체")

# ── Android: 앱 버전 확인·Play 스토어 열기(업데이트 안내용 채널) ─────────────
kotlin_dir = MOBILE / "android/app/src/main/kotlin"
if kotlin_dir.exists():
    existing = list(kotlin_dir.rglob("MainActivity.kt"))
    target = existing[0] if existing else kotlin_dir.joinpath(*app_id.split("."), "MainActivity.kt")
    target.parent.mkdir(parents=True, exist_ok=True)
    pkg = ".".join(target.relative_to(kotlin_dir).parts[:-1])
    target.write_text(f"""package {pkg}

import android.content.Intent
import android.net.Uri
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.UpdateAvailability

// eumtalk: tool/bootstrap.py 가 만든다. 앱 버전 번호 확인과 Play 스토어 열기(업데이트 안내).
class MainActivity : FlutterActivity() {{
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {{
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "eumtalk/app").setMethodCallHandler {{ call, result ->
            when (call.method) {{
                "versionInfo" -> {{
                    val info = packageManager.getPackageInfo(packageName, 0)
                    val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                    result.success(mapOf("build" to code, "name" to (info.versionName ?: "")))
                }}
                // Google Play 에 이 앱의 새 버전이 있는지(Play 에서 설치한 앱만 알 수 있다)
                "playUpdateInfo" -> {{
                    try {{
                        AppUpdateManagerFactory.create(this).appUpdateInfo
                            .addOnSuccessListener {{ info ->
                                val available = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE ||
                                    info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
                                result.success(mapOf("available" to available, "versionCode" to info.availableVersionCode().toLong()))
                            }}
                            .addOnFailureListener {{ result.success(null) }}
                    }} catch (e: Exception) {{
                        result.success(null)
                    }}
                }}
                "openStore" -> {{
                    val web = call.argument<String>("url") ?: "https://play.google.com/store/apps/details?id=$packageName"
                    try {{
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }} catch (e: Exception) {{
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(web)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }}
                    result.success(true)
                }}
                else -> result.notImplemented()
            }}
        }}
    }}
}}
""", encoding="utf-8")
    step(f"MainActivity: 버전 확인·스토어 열기 채널 ({pkg})")

step("완료. 이어서: flutter pub get && flutter run --dart-define=API_BASE_URL=http://<서버주소>:3000")
sys.exit(0)
