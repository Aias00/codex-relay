#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
go_root="$package_root/go"
output="$package_root/ios/TailcatMobile.xcframework"
mobile_version="v0.0.0-20260821190718-4776eadac327"
targets="${TAILCAT_IOS_TARGETS:-ios,iossimulator}"

export PATH="$(go env GOPATH)/bin:$PATH"

command -v gomobile >/dev/null || go install "golang.org/x/mobile/cmd/gomobile@$mobile_version"
command -v gobind >/dev/null || go install "golang.org/x/mobile/cmd/gobind@$mobile_version"

cd "$go_root"
go mod download
gomobile bind \
  -target="$targets" \
  -iosversion=16.4 \
  -prefix=CR \
  -ldflags='-s -w' \
  -o "$output" \
  .

if [[ -z "${TAILCAT_IOS_TARGETS:-}" ]]; then
  simulator_binary="$(find "$output" -path '*-simulator/TailcatMobile.framework/TailcatMobile' -type f -print -quit)"
  if [[ -z "$simulator_binary" ]]; then
    echo "Missing TailcatMobile iOS simulator framework slice." >&2
    exit 1
  fi
  simulator_architectures="$(lipo -archs "$simulator_binary")"
  for architecture in arm64 x86_64; do
    if [[ " $simulator_architectures " != *" $architecture "* ]]; then
      echo "TailcatMobile simulator framework is missing $architecture." >&2
      exit 1
    fi
  done
fi
