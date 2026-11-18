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
    for perm in ("android.permission.INTERNET", "android.permission.ACCESS_COARSE_LOCATION"):
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

# ── iOS ──────────────────────────────────────────────────────────────────
plist_path = MOBILE / "ios/Runner/Info.plist"
if plist_path.exists():
    with plist_path.open("rb") as f:
        plist = plistlib.load(f)
    plist["CFBundleDisplayName"] = app_name
    plist["NSLocationWhenInUseUsageDescription"] = LOCATION_REASON
    plist["NSPhotoLibraryUsageDescription"] = "프로필·대화·게시글에 올릴 사진을 고를 때 사용합니다."
    plist["NSCameraUsageDescription"] = "프로필·대화·게시글에 올릴 사진을 찍을 때 사용합니다."
    with plist_path.open("wb") as f:
        plistlib.dump(plist, f)
    step("Info.plist: 표시 이름·위치 사용 문구 반영")

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

step("완료. 이어서: flutter pub get && flutter run --dart-define=API_BASE_URL=http://<서버주소>:3000")
sys.exit(0)
