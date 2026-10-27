// Entry point of the Swift reference harness (one fixture × one environment per process).
//
//   <Brand>Ref --fixture <path> --kind file|journal --id <fixture id> --out <json>
//              [--skip <json file of key → reason>] [--components false]
//              [--source-sha <sha>] [--xcode <version>]
//   <Brand>Ref --backups <dir> --fixture <journal json>        (F10 Mac backup vectors)
//   <Brand>Ref --samples <json>                                 (sample-trade invariants)
//
// TZ and -AppleLocale are set by the driver (tools/swift-ref/run.mjs).
import Foundation

let refArgs = RefArgs(CommandLine.arguments)

@MainActor
func refLoadJournal(_ path: String) -> [Trade] {
    guard let data = FileManager.default.contents(atPath: path),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rows = root["trades"] as? [[String: Any]] else {
        refLog("cannot read journal \(path)")
        exit(3)
    }
    return rows.map(refMakeTrade)
}

@MainActor
func refFullTrade(_ t: Trade) -> RefJSON {
    // Every stored field (Mirror over the model), plus brand extras such as the content key.
    let mirror = Mirror(reflecting: t)
    var obj: [(String, RefJSON)] = []
    for c in mirror.children {
        guard let label = c.label else { continue }
        if label == "importedAt" { continue }
        if label == "ticket" { obj.append((label, .string(String(t.ticket)))); continue }
        obj.append((label, refEncode(c.value)))
    }
    obj += refParsedExtras(t)
    obj += refValidation(t)
    return .object(obj.sorted { $0.0 < $1.0 })
}

@MainActor
func refMain() -> Int32 {
    if let samplesOut = refArgs["samples"] {
        let text = refSerialize(refSampleInvariants(), indent: 1) + "\n"
        FileManager.default.createFile(atPath: samplesOut, contents: Data(text.utf8))
        return 0
    }
    guard let fixture = refArgs["fixture"] else {
        refLog("missing --fixture")
        return 2
    }
    if let backups = refArgs["backups"] {
        do {
            let summary = try refWriteBackups(refLoadJournal(fixture), to: URL(fileURLWithPath: backups),
                                              password: refArgs["password"] ?? "fixture-password-1")
            let text = refSerialize(summary, indent: 1) + "\n"
            FileManager.default.createFile(atPath: backups + "/backups.json", contents: Data(text.utf8))
            return 0
        } catch {
            refLog("backups failed: \(error)")
            return 4
        }
    }
    guard let out = refArgs["out"] else {
        refLog("missing --out")
        return 2
    }
    var skip: [String: String] = [:]
    if let skipFile = refArgs["skip"], let data = FileManager.default.contents(atPath: skipFile),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
        skip = dict
    }
    let kind = refArgs["kind"] ?? "file"
    let now = Date()

    // 1. Import or load
    var section: [(String, RefJSON)] = [("kind", .string(kind))]
    let parsed: [Trade]
    if kind == "journal" {
        parsed = refLoadJournal(fixture)
        section.append(("route", .string("journal")))
    } else {
        parsed = refParseFile(fixture, into: &section)
    }
    refMark("$import.parsed")
    section.append(("parsedCount", .int(Int64(parsed.count))))
    section.append(("parsed", .array(parsed.map(refFullTrade))))

    // 2. Store through the app's repository and read back (close time descending)
    refMark("$import.store")
    let journal = refStore(parsed, into: &section)
    section.append(("journalCount", .int(Int64(journal.count))))
    section.append(("journal", .array(journal.map(refFullTrade))))

    // 3. Analytics on the stored journal
    refMark("$analytics.context")
    let metrics = MetricsCalculator.calculate(from: journal)
    let byClose = journal.map(\.closeTime).sorted()
    let middle = byClose.isEmpty ? Date(timeIntervalSince1970: 0) : byClose[byClose.count / 2]
    let checkpoint = StrategyCheckpoint(date: middle, title: "Fixture checkpoint", description: "fictional",
                                        createdAt: refFixedImportDate)
    let ctx = RefContext(trades: journal, metrics: metrics, checkpoints: [checkpoint],
                         lastClose: journal.first?.closeTime ?? Date(timeIntervalSince1970: 0))
    var outputs = refBrandOutputs(ctx)
    if refArgs["components"] == "false" {
        let keep: Set<String> = ["Metrics", "Metrics.edgeByHour", "Metrics.edgeBySession", "Metrics.edgeByDay"]
        outputs = outputs.filter { keep.contains($0.key) }
    }
    let values = refEvaluate(outputs, skip: skip)

    let calendar = Calendar.current
    #if compiler(>=6.1)
    let swiftVersion = "6.1+"
    #else
    let swiftVersion = "6.0"
    #endif
    let root: RefJSON = .object([
        ("schema", .int(1)),
        ("brand", .string(refBrand)),
        ("fixture", .string(refArgs["id"] ?? fixture)),
        ("source_sha", .string(refArgs["source-sha"] ?? "")),
        ("xcode", .string(refArgs["xcode"] ?? "")),
        ("swift", .string(swiftVersion)),
        ("tz", .string(TimeZone.current.identifier)),
        ("locale", .string(Locale.current.identifier)),
        ("firstWeekday", .int(Int64(calendar.firstWeekday))),
        ("minimumDaysInFirstWeek", .int(Int64(calendar.minimumDaysInFirstWeek))),
        ("now", .string(RefFormat.iso.string(from: now))),
        ("import", .object(section)),
        ("outputs", .object(values)),
        ("skipped", refEncode(skip)),
    ])
    let text = refSerialize(root, indent: 1) + "\n"
    guard FileManager.default.createFile(atPath: out, contents: Data(text.utf8)) else {
        refLog("cannot write \(out)")
        return 5
    }
    return 0
}

exit(refMain())
