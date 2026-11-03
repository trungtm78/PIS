import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {

}

// SEC-04, decision D-SEC-03 of docs/mobile-security-review.md: the screens that show money or a decision ask for a protected window
// (method channel "vn.machvon/secure_window", `set` with `enabled`). While it is on, a cover hides the content when the scene leaves
// the foreground (the thumbnail of the app switcher is taken from what the window shows then) and while the screen is being
// recorded or mirrored. The cover is a plain view of the system background colour, with nothing of the application in it.
final class SecureWindow {
  static let shared = SecureWindow()
  static let channelName = "vn.machvon/secure_window"

  private var enabled = false
  private var inactive = false
  private var covers: [UIView] = []
  private var observers: [NSObjectProtocol] = []

  func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: SecureWindow.channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "set" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let arguments = call.arguments as? [String: Any], let on = arguments["enabled"] as? Bool else {
        result(FlutterError(code: "BAD_ARGUMENTS", message: "enabled is required", details: nil))
        return
      }
      self?.enabled = on
      self?.refresh()
      result(nil)
    }
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] _ in
      self?.inactive = true
      self?.refresh()
    })
    observers.append(center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
      self?.inactive = false
      self?.refresh()
    })
    observers.append(center.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.refresh()
    })
  }

  private func shouldCover() -> Bool {
    return enabled && (inactive || UIScreen.main.isCaptured)
  }

  private func refresh() {
    if shouldCover() {
      showCovers()
    } else {
      hideCovers()
    }
  }

  private func showCovers() {
    guard covers.isEmpty else { return }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows {
        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = UIColor.systemBackground
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.isAccessibilityElement = false
        window.addSubview(cover)
        covers.append(cover)
      }
    }
  }

  private func hideCovers() {
    for cover in covers {
      cover.removeFromSuperview()
    }
    covers.removeAll()
  }
}
