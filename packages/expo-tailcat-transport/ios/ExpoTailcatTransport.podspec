require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'ExpoTailcatTransport'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = 'Codex Relay'
  s.homepage         = 'https://github.com/Aias00/codex-relay'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :git => 'https://github.com/Aias00/codex-relay.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'TailcatTransportModule.swift'
  s.vendored_frameworks = 'TailcatMobile.xcframework'
  s.preserve_paths = 'TailcatMobile.xcframework'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
