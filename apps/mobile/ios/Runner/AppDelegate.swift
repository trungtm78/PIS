import Flutter
import MachO
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    excludeOfflineStoreFromBackup()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "MachvonNative") {
      SecureWindow.shared.register(messenger: registrar.messenger())
      DeviceIntegrity.register(messenger: registrar.messenger())
    }
  }

  // SEC-03: the folder of the encrypted databases and of the files of the uploads (`offline` in Application Support, see
  // `offlineDirectoryProvider`) is not part of a backup of the phone. The database is useless without its key, which never leaves the
  // Keychain, but the photographs are plain files: they must not be restored on another phone. The flag is set on the folder
  // before the application creates anything in it, and it applies to everything inside.
  private func excludeOfflineStoreFromBackup() {
    let fileManager = FileManager.default
    guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
    var folder = support.appendingPathComponent("offline", isDirectory: true)
    do {
      try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
    } catch {
      // The store is created by the application when it is needed; a folder that cannot be flagged here is flagged on the next start.
    }
  }
}

// INTEG-01, decision D-SEC-01 of docs/mobile-security-review.md: the signals of a modified phone, read on request over the method
// channel "vn.machvon/device_integrity". They are a risk input for the policy of the tenant, never a gate: every one of them can be
// hidden by the owner of the phone.
enum DeviceIntegrity {
  static let channelName = "vn.machvon/device_integrity"

  static func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "read" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result([
        "rooted": false,
        "jailbroken": isJailbroken(),
        "debuggerAttached": isDebuggerAttached(),
        "hookingFramework": hasHookingFramework(),
        "emulator": isSimulator(),
      ])
    }
  }

  private static func isSimulator() -> Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }

  private static func isJailbroken() -> Bool {
    if isSimulator() { return false }
    let paths = [
      "/Applications/Cydia.app",
      "/Library/MobileSubstrate/MobileSubstrate.dylib",
      "/bin/bash",
      "/usr/sbin/sshd",
      "/etc/apt",
      "/private/var/lib/apt/",
    ]
    return paths.contains { FileManager.default.fileExists(atPath: $0) }
  }

  private static func isDebuggerAttached() -> Bool {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    let status = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
    return status == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
  }

  private static func hasHookingFramework() -> Bool {
    let markers = ["frida", "substrate", "cycript", "libhooker"]
    for index in 0..<_dyld_image_count() {
      guard let name = _dyld_get_image_name(index) else { continue }
      let image = String(cString: name).lowercased()
      if markers.contains(where: { image.contains($0) }) { return true }
    }
    return false
  }
}
