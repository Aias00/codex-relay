# Third-Party Notices

The vendored `TailcatMobile.xcframework` includes Tailcat v0.3.0 and its transitive Go
dependencies. Tailcat is Copyright (c) 2020 Tailscale Inc & contributors and is distributed
under the BSD 3-Clause License. The full Tailcat license is included as `TAILCAT_LICENSE`.

The framework build is reproducible from `go/go.mod`, `go/go.sum`, and
`scripts/build-ios-framework.sh`. Tailcat is pinned because its public Go API is not stable.
