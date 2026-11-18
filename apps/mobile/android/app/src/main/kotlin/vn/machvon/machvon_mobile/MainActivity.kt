package vn.machvon.machvon_mobile

import android.content.Intent
import android.os.Build
import android.os.Debug
import android.util.Log
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

// The biometric prompt of local_auth (the unlock of the stored session) needs a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        // SEC-04, decision D-SEC-03 of docs/mobile-security-review.md: the screens that show money or a decision ask for a window that
        // cannot be captured (no screenshot, no screen recording, a blank thumbnail in the app switcher) and give it back when they go.
        MethodChannel(messenger, SECURE_WINDOW_CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "set" -> {
                    val enabled = call.argument<Boolean>("enabled")
                    if (enabled == null) {
                        result.error("BAD_ARGUMENTS", "enabled is required", null)
                    } else {
                        if (enabled) {
                            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        }
                        result.success(null)
                    }
                }
                else -> result.notImplemented()
            }
        }

        // INTEG-01, decision D-SEC-01: the signals of a modified phone, a risk input for the tenant policy and never a gate.
        MethodChannel(messenger, DEVICE_INTEGRITY_CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "read" -> result.success(
                    mapOf(
                        "rooted" to isRooted(),
                        "jailbroken" to false,
                        "debuggerAttached" to Debug.isDebuggerConnected(),
                        "hookingFramework" to hasHookingFramework(),
                        "emulator" to isEmulator(),
                    ),
                )
                else -> result.notImplemented()
            }
        }

        // The sign-in runs in a browser tab that sits on top of this activity, in this task. A browser with Auth Tab closes the tab itself when the
        // provider redirects; an older one (Custom Tabs only) leaves it there, because the activity that takes the redirect lives in a task of its
        // own (`taskAffinity=""`, kept on purpose: no other application can put an activity into this task) and so cannot clear this one. Once the
        // redirect has reached the application, it asks for its own activity again: everything above it in the task (the tab and the helper of the
        // plugin) is cleared and this same instance comes back to the front. No new instance, no history flag, nothing of the session in the intent.
        MethodChannel(messenger, APP_TASK_CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "bringToFront" -> {
                    try {
                        startActivity(
                            Intent(this, MainActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        )
                        result.success(null)
                    } catch (e: Exception) {
                        Log.w(LOG_TAG, "bringToFront failed: ${e.javaClass.simpleName}")
                        result.error("BRING_TO_FRONT_FAILED", e.javaClass.simpleName, null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun isRooted(): Boolean {
        val tags = Build.TAGS
        if (tags != null && tags.contains("test-keys")) return true
        return SU_PATHS.any { File(it).exists() }
    }

    private fun hasHookingFramework(): Boolean {
        return try {
            File("/proc/self/maps").useLines { lines ->
                lines.any { line -> HOOK_MARKERS.any { line.contains(it, ignoreCase = true) } }
            }
        } catch (e: Exception) {
            false
        }
    }

    private fun isEmulator(): Boolean {
        return Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.PRODUCT.contains("sdk_gphone")
    }

    companion object {
        const val SECURE_WINDOW_CHANNEL = "vn.machvon/secure_window"
        const val DEVICE_INTEGRITY_CHANNEL = "vn.machvon/device_integrity"
        const val APP_TASK_CHANNEL = "vn.machvon/app_task"
        private const val LOG_TAG = "MachvonMain"

        private val SU_PATHS = listOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/system/su",
            "/data/local/xbin/su",
            "/data/local/bin/su",
            "/system/app/Superuser.apk",
        )

        private val HOOK_MARKERS = listOf("frida", "xposed", "substrate")
    }
}
