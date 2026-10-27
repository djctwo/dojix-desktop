// Dojix-specific part of the Swift reference harness: import routing exactly as the Mac's
// ImportViewModel does it, storage through the app's own repository, and the analytics.
import CryptoKit
import Foundation

let refBrand = "dojix"

/// A stored trade from a journal fixture (see tools/fixture-gen/src/journal.ts).
@MainActor
func refMakeTrade(_ d: [String: Any]) -> Trade {
    func s(_ k: String) -> String { refStringValue(d[k]) }
    func dbl(_ k: String) -> Double { refDoubleValue(d[k]) }
    func int(_ k: String) -> Int { refIntValue(d[k]) }
    func dec(_ k: String) -> Decimal { refDecimalValue(d[k]) }
    func bool(_ k: String) -> Bool { refBoolValue(d[k]) }
    func date(_ k: String) -> Date { RefFormat.date(s(k)) ?? Date(timeIntervalSince1970: 0) }
    return Trade(
        id: nil,
        ticket: refInt64Value(d["ticket"]),
        symbol: s("symbol"),
        direction: TradeDirection(rawValue: s("direction")) ?? .buy,
        lots: dbl("lots"),
        openTime: date("openTime"),
        closeTime: date("closeTime"),
        durationMin: int("durationMin"),
        openPrice: dec("openPrice"),
        closePrice: dec("closePrice"),
        sl: dec("sl"),
        tp: dec("tp"),
        netProfit: dec("netProfit"),
        maePips: dbl("maePips"),
        mfePips: dbl("mfePips"),
        rMultiple: dbl("rMultiple"),
        session: TradingSession(rawValue: s("session")) ?? .late,
        dayOfWeek: s("dayOfWeek"),
        hour: int("hour"),
        rangeSize: dbl("rangeSize"),
        sweepDepth: dbl("sweepDepth"),
        usedFVG: bool("usedFVG"),
        volRegime: VolatilityRegime(rawValue: s("volRegime")) ?? .med,
        hitBreakeven: bool("hitBreakeven"),
        scaledIn: bool("scaledIn"),
        magic: int("magic"),
        comment: s("comment"),
        timeToMFEMin: int("timeToMFEMin"),
        slDistPips: dbl("slDistPips"),
        slippagePips: dbl("slippagePips"),
        postClose15m: dbl("postClose15m"),
        postClose30m: dbl("postClose30m"),
        biasAtEntry: BiasAlignment(rawValue: s("biasAtEntry")) ?? .neutral,
        notes: s("notes"),
        tags: s("tags"),
        emotion: s("emotion"),
        screenshots: s("screenshots"),
        checklistData: s("checklistData"),
        commission: dec("commission"),
        swap: dec("swap"),
        importedAt: refFixedImportDate
    )
}

/// importedAt is "now" in the app; a fixed value keeps the outputs reproducible.
let refFixedImportDate = Date(timeIntervalSince1970: 1_767_225_600)

private func refFixImportDate(_ trades: [Trade]) -> [Trade] {
    trades.map { var t = $0; t.importedAt = refFixedImportDate; return t }
}

/// Parses a fixture file the way the Mac's Import view routes it.
@MainActor
func refParseFile(_ path: String, into section: inout [(String, RefJSON)]) -> [Trade] {
    let filename = URL(fileURLWithPath: path).lastPathComponent
    var trades: [Trade] = []
    func record(_ error: Error) {
        section.append(("error", .object([("type", .string(String(describing: error))),
                                          ("message", .string(error.localizedDescription))])))
    }
    // The MT5 watcher / StrategyAnalytics importer path (always the 32-column parser).
    do {
        let direct = try CSVParser.parse(fileAt: path)
        section.append(("saDirect", .object([("count", .int(Int64(direct.count)))])))
    } catch {
        section.append(("saDirect", .object([("error", .string(String(describing: error)))])))
    }
    if filename.hasPrefix("StrategyAnalytics") || filename.hasPrefix("SA_Results") {
        section.append(("route", .string("sa32 (file name)")))
        do { trades = try CSVParser.parse(fileAt: path) } catch { record(error) }
        return refFixImportDate(trades)
    }
    do {
        let detection = try GenericCSVParser.detect(fileAt: path)
        section.append(("detect", refEncode(detection)))
        switch detection.platform {
        case .strategyAnalytics:
            section.append(("route", .string("sa32 (detected)")))
            trades = try CSVParser.parse(fileAt: path)
        case .generic:
            section.append(("route", .string("column mapping (no trades without a user mapping)")))
        default:
            section.append(("route", .string("generic:\(detection.platform.rawValue)")))
            if let mapping = detection.mapping {
                trades = try GenericCSVParser.parse(fileAt: path, mapping: mapping)
            }
        }
    } catch {
        record(error)
    }
    return refFixImportDate(trades)
}

/// Extra per-parsed-trade values: the content key behind a content ticket.
@MainActor
func refParsedExtras(_ t: Trade) -> [(String, RefJSON)] {
    [("contentKey", .string(GenericCSVParser.contentKey(for: t)))]
}

/// Storage through the app's own repository (Trade+Sanitize clamps on insert).
@MainActor
func refStore(_ trades: [Trade], into section: inout [(String, RefJSON)]) -> [Trade] {
    do {
        let db = try DatabaseManager(inMemory: true)
        let repo = TradeRepository(database: db)
        let inserted = try repo.bulkInsert(trades)
        let again = try repo.bulkInsert(trades)
        section.append(("inserted", .int(Int64(inserted))))
        section.append(("reimportInserted", .int(Int64(again))))
        return try repo.fetchAll()
    } catch {
        section.append(("storeError", .string(String(describing: error))))
        return []
    }
}

/// Values the app stores or shows per trade before insert (clamp form) and on restore (reject form).
@MainActor
func refValidation(_ t: Trade) -> [(String, RefJSON)] {
    [("storageViolations", refEncode(t.storageViolations()))]
}

@MainActor
func refBrandOutputs(_ ctx: RefContext) -> [RefOutput] {
    let t = ctx.trades
    let m = ctx.metrics
    var out: [RefOutput] = [
        RefOutput("Metrics") { m },
        RefOutput("Metrics.edgeByHour") { MetricsCalculator.edgeByHour(from: t) },
        RefOutput("Metrics.edgeBySession") { MetricsCalculator.edgeBySession(from: t) },
        RefOutput("Metrics.edgeByDay") { MetricsCalculator.edgeByDay(from: t) },
        RefOutput("Metrics.edgeByPair") { MetricsCalculator.edgeByPair(from: t) },
        RefOutput("Metrics.edgeByBias") { MetricsCalculator.edgeByBias(from: t) },
        RefOutput("Metrics.edgeByVolRegime") { MetricsCalculator.edgeByVolRegime(from: t) },
        RefOutput("Metrics.allEdgeConditions[tradingDays=21]") { MetricsCalculator.allEdgeConditions(from: t, tradingDays: 21) },
        RefOutput("Metrics.confidence") {
            [0, 1, 9, 10, 29, 30, 31, 100].map {
                (n: $0, level: MetricsCalculator.confidenceLevel(sampleSize: $0),
                 actionable: MetricsCalculator.isActionable(sampleSize: $0))
            }
        },
        RefOutput("TradeGrader.grades") {
            t.map { (ticket: String($0.ticket), grade: TradeGrader.grade($0, portfolioMetrics: m)) }
        },
        RefOutput("StrategyCheckpoints.split") { refCheckpointSplit(ctx) },
        RefOutput("Trade.derived") { refPerTrade(t) },
    ]
    out += refComponentOutputs(ctx)
    return out
}

/// Before/after metrics for the fixture checkpoint, as StrategyCheckpoints computes them.
@MainActor
func refCheckpointSplit(_ ctx: RefContext) -> Any {
    let view = StrategyCheckpoints(trades: ctx.trades, checkpoints: ctx.checkpoints)
    return ctx.checkpoints.map { cp -> [String: Any] in
        let before = ctx.trades.filter { $0.closeTime < cp.date }.sorted { $0.closeTime < $1.closeTime }
        let after = ctx.trades.filter { $0.closeTime >= cp.date }.sorted { $0.closeTime < $1.closeTime }
        return ["date": cp.date, "before": view.metrics(for: before), "after": view.metrics(for: after),
                "beforeCount": before.count, "afterCount": after.count]
    }
}

@MainActor
func refPerTrade(_ trades: [Trade]) -> Any {
    trades.map { t -> RefJSON in
        var obj: [(String, RefJSON)] = [("ticket", .string(String(t.ticket)))]
        obj += refTradeExtras(t).map { ($0.0, refEncode($0.1)) }
        obj.append(("open", .object(refDateExtras(t.openTime).map { ($0.0, refEncode($0.1)) })))
        obj.append(("close", .object(refDateExtras(t.closeTime).map { ($0.0, refEncode($0.1)) })))
        return .object(obj)
    }
}

/// Fictional sample trades: random on the Mac, so only their invariants are recorded.
@MainActor
func refSampleInvariants() -> RefJSON {
    let s = DemoDataGenerator.generateTrades()
    return .object([
        ("count", .int(Int64(s.count))),
        ("minTicket", .string(String(s.map(\.ticket).min() ?? 0))),
        ("maxTicket", .string(String(s.map(\.ticket).max() ?? 0))),
        ("comments", refEncode(Array(Set(s.map(\.comment))).sorted())),
    ])
}

/// F10: Mac backup files written by the app's own code from a journal.
@MainActor
func refWriteBackups(_ trades: [Trade], to dir: URL, password: String) throws -> RefJSON {
    let db = try DatabaseManager(inMemory: true)
    let repo = TradeRepository(database: db)
    _ = try repo.bulkInsert(trades)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let plain = dir.appendingPathComponent("dojix-plain.sqlite")
    let sealed = dir.appendingPathComponent("dojix-djxb.backup")
    let legacy = dir.appendingPathComponent("dojix-dojx-legacy.backup")
    try BackupService.writeBackup(of: db, to: plain)
    try BackupService.writeBackup(of: db, to: sealed, password: password)
    // Dojix 1.x encrypted export ("DOJX"), written the way DojixTests/LegacyExportWriter does.
    let image = try Data(contentsOf: plain)
    let salt = KeyDerivation.generateSalt()
    let key = try ExportEncryption.legacyKey(password: password, salt: salt)
    guard let box = try AES.GCM.seal(image, using: key).combined else { throw CocoaError(.coderInvalidValue) }
    try (ExportEncryption.magic + salt + box).write(to: legacy)
    return .object([
        ("password", .string(password)),
        ("files", .array([
            .object([("file", .string(plain.lastPathComponent)), ("format", .string("plain SQLite"))]),
            .object([("file", .string(sealed.lastPathComponent)), ("format", .string("DJXB")),
                     ("iterations", .int(Int64(BackupEncryption.defaultIterations)))]),
            .object([("file", .string(legacy.lastPathComponent)), ("format", .string("DOJX (1.x)"))]),
        ])),
        ("trades", .int(Int64(try repo.count()))),
        ("tickets", refEncode(try repo.fetchAll().map { String($0.ticket) })),
    ])
}
