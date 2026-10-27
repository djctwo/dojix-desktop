// swift-tools-version:6.0
// Swift reference harness for Dojix (tools/swift-ref). Built and run only in CI on macOS
// (.github/workflows/parity-reference.yml): prepare.mjs copies the app's sources at the
// pinned commit into Sources/DojixRef/App before `swift build`.
import PackageDescription

let package = Package(
    name: "DojixRef",
    platforms: [.macOS(.v14)],
    dependencies: [
        // The commit the app pins (GRDB 7.11.1), never a moving tag.
        .package(url: "https://github.com/groue/GRDB.swift", revision: "b83108d10f42680d78f23fe4d4d80fc88dab3212"),
    ],
    targets: [
        .executableTarget(
            name: "DojixRef",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")],
            path: "Sources/DojixRef",
            exclude: [],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
