import 'package:device_info_plus_platform_interface/device_info_plus_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/release/app_info.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

class _Phone extends DeviceInfoPlatform with MockPlatformInterfaceMixin {
  @override
  Future<BaseDeviceInfo> deviceInfo() async => BaseDeviceInfo(<String, dynamic>{
        'version': <String, dynamic>{
          'baseOS': null,
          'codename': 'REL',
          'incremental': '1',
          'previewSdkInt': null,
          'release': '14',
          'sdkInt': 34,
          'securityPatch': null,
        },
        'board': 'b',
        'bootloader': 'b',
        'brand': 'brand',
        'device': 'd',
        'display': 'd',
        'fingerprint': 'f',
        'hardware': 'h',
        'host': 'h',
        'id': 'i',
        'manufacturer': 'm',
        'model': 'm',
        'product': 'p',
        'name': 'n',
        'tags': 't',
        'time': 1,
        'type': 'user',
        'isPhysicalDevice': true,
        'freeDiskSize': 1,
        'totalDiskSize': 2,
        'isLowRamDevice': false,
        'physicalRamSize': 3,
        'availableRamSize': 2,
      });
}

void main() {
  group('AC-ST-MOB-016-3 UI-MOB-50 the app and OS versions that go into a help request', () {
    final DeviceInfoPlatform original = DeviceInfoPlatform.instance;
    tearDown(() => DeviceInfoPlatform.instance = original);

    test('are read from the package and from the operating system, and say nothing about the person or the device', () async {
      PackageInfo.setMockInitialValues(
        appName: 'MACHVON',
        packageName: 'vn.machvon.machvon_mobile',
        version: '1.4.0',
        buildNumber: '27',
        buildSignature: '',
      );
      DeviceInfoPlatform.instance = _Phone();
      final AppInfo info = await const PlatformAppInfoSource().read();
      expect((info.version, info.build, info.platform, info.osVersion), ('1.4.0', '27', 'android', '14'));
      expect(info.full, '1.4.0+27');
      expect(info.summary, 'app 1.4.0+27, android 14');
    });
  });
}
