import ExpoModulesCore
import TailcatMobile

public final class TailcatTransportModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TailcatTransport")

    Constant("enabled") {
      Bundle.main.object(forInfoDictionaryKey: "CodexRelayTailcatTransportEnabled") as? Bool == true
    }

    AsyncFunction("start") { (token: String, targetPort: Int) -> String in
      var error: NSError?
      let cachePath = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
        .first?
        .appendingPathComponent("codex-relay/tailcat", isDirectory: true)
        .path ?? ""
      let endpoint = CRTailcatmobileStart(token, targetPort, cachePath, &error)
      if let error {
        throw error
      }
      return endpoint
    }

    AsyncFunction("stop") {
      CRTailcatmobileStop()
    }

    AsyncFunction("path") { (timeoutMs: Int) -> String in
      CRTailcatmobilePath(timeoutMs)
    }
  }
}
