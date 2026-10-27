// Greenwick-specific part of the Swift reference harness: import routing as the Mac's
// ImportViewModel does it (FIFO for transaction exports), storage through the app's own
// repository (TradeLimits rejects), and the analytics.
import CryptoKit
import Foundation

let refBrand = "greenwick"

/// importedAt is "now" in the app; a fixed value keeps the outputs reproducible.
let refFixedImportDate = Date(timeIntervalSince1970: 1_767_225_600)

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
        shares: dbl("shares"),
        openTime: date("openTime"),
        closeTime: date("closeTime"),
        durationMin: int("durationMin"),
        openPrice: dec("openPrice"),
        closePrice: dec("closePrice"),
        sl: dec("sl"),
        tp: dec("tp"),
        netProfit: dec("netProfit"),
        maePoints: dbl("maePoints"),
        mfePoints: dbl("mfePoints"),
        rMultiple: dbl("rMultiple"),
        session: MarketSession(rawValue: s("session")) ?? .extended,
        dayOfWeek: s("dayOfWeek"),
        hour: int("hour"),
        rangeSize: dbl("rangeSize"),
        hitBreakeven: bool("hitBreakeven"),
        scaledIn: bool("scaledIn"),
        comment: s("comment"),
        timeToMFEMin: int("timeToMFEMin"),
        slDistPoints: dbl("slDistPoints"),
        slippagePoints: dbl("slippagePoints"),
        sector: s("sector"),
        industry: s("industry"),
        volume: int("volume"),
        avgVolume: int("avgVolume"),
        notes: s("notes"),
        tags: s("tags"),
        emotion: s("emotion"),
        screenshots: s("screenshots"),
        checklistData: s("checklistData"),
        commission: dec("commission"),
        swap: dec("swap"),
        importedAt: refFixedImportDate,
        isSample: bool("isSample")
    )
}

private func refFixImportDate(_ trades: [Trade]) -> [Trade] {
    trades.map { var t = $0; t.importedAt = refFixedImportDate; return t }
}

/// Parses a fixture file the way the Mac's Import view routes it.
@MainActor
func refParseFile(_ path: String, into section: inout [(String, RefJSON)]) -> [Trade] {
    var trades: [Trade] = []
    do {
        let detection = try GenericCSVParser.detect(fileAt: path)
        section.append(("detect", refEncode(detection)))
        if detection.platform == .generic {
            section.append(("route", .string("column mapping (no trades without a user mapping)")))
        } else if let mapping = detection.mapping {
            section.append(("route", .string(mapping.platform.needsFIFOPairing
                ? "fifo:\(mapping.platform.rawValue)" : "generic:\(mapping.platform.rawValue)")))
            trades = try GenericCSVParser.parse(fileAt: path, mapping: mapping)
        }
    } catch {
        section.append(("error", .object([("type", .string(String(describing: error))),
                                          ("message", .string(error.localizedDescription))])))
    }
    return refFixImportDate(trades)
}

@MainActor
func refParsedExtras(_ t: Trade) -> [(String, RefJSON)] { [] }

/// Storage through the app's own repository (TradeLimits: out-of-range rows are refused).
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

@MainActor
func refValidation(_ t: Trade) -> [(String, RefJSON)] {
    [("storageViolations", refEncode(t.storageViolations)),
     ("controlCharacterFields", refEncode(t.controlCharacterFields)),
     ("rejected", .bool(t.sanitizedForStorage() == nil))]
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
        RefOutput("Metrics.edgeBySymbol") { MetricsCalculator.edgeBySymbol(from: t) },
        RefOutput("Metrics.edgeBySector") { MetricsCalculator.edgeBySector(from: t) },
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
        RefOutput("TradingCalendar.tradingDayCount") { TradingCalendar.tradingDayCount(t) },
        RefOutput("TradingCalendar.dailyPnL") {
            TradingCalendar.dailyPnL(t).map { (day: TradingCalendar.dayKey($0.key), pnl: $0.value) }
                .sorted { $0.day < $1.day }
        },
        RefOutput("TradingCalendar.groupedByWeekday") {
            TradingCalendar.groupedByWeekday(t).mapValues { $0.map { String($0.ticket) } }
        },
        RefOutput("TicketKeyCounter.vectors") {
            ["a#0", "FIXA|BUY#0", "Robinhood|FIXA|1770000000.0|10|100.0#1", ""].map {
                (key: $0, ticket: String(TicketKeyCounter.hash($0)))
            }
        },
        RefOutput("StrategyCheckpoints.split") { refCheckpointSplit(ctx) },
        RefOutput("Trade.derived") { refPerTrade(t) },
    ]
    out += refComponentOutputs(ctx)
    return out
}

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
        obj.append(("closeDayKey", .string(TradingCalendar.dayKey(t.closeTime))))
        obj.append(("openMinuteOfDay", .int(Int64(TradingCalendar.minuteOfDay(t.openTime)))))
        return .object(obj)
    }
}

@MainActor
func refSampleInvariants() -> RefJSON {
    let s = DemoDataGenerator.generateTrades()
    return .object([
        ("count", .int(Int64(s.count))),
        ("minTicket", .string(String(s.map(\.ticket).min() ?? 0))),
        ("maxTicket", .string(String(s.map(\.ticket).max() ?? 0))),
        ("comments", refEncode(Array(Set(s.map(\.comment))).sorted())),
        ("allSample", .bool(s.allSatisfy(\.isSample))),
    ])
}

/// F10: Mac backup files written by the app's own code from a journal.
@MainActor
func refWriteBackups(_ trades: [Trade], to dir: URL, password: String) throws -> RefJSON {
    let db = try DatabaseManager(inMemory: true)
    let repo = TradeRepository(database: db)
    _ = try repo.bulkInsert(trades)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let plain = dir.appendingPathComponent("greenwick-plain.sqlite")
    let sealed = dir.appendingPathComponent("greenwick-gwbk.backup")
    let legacy = dir.appendingPathComponent("greenwick-sjnl-legacy.backup")
    let image = try db.serializedSnapshot()
    try image.write(to: plain)
    try BackupEncryption.encrypt(image, password: password).write(to: sealed)
    // Older "SJNL" format, built the way GreenwickTests/BackupEncryptionTests does.
    let salt = KeyDerivation.generateSalt(length: 16)
    guard let raw = KeyDerivation.deriveKey(password: password, salt: salt, iterations: 100_000),
          let box = try AES.GCM.seal(image, using: SymmetricKey(data: raw)).combined else {
        throw CocoaError(.coderInvalidValue)
    }
    try (Data("SJNL".utf8) + salt + box).write(to: legacy)
    return .object([
        ("password", .string(password)),
        ("files", .array([
            .object([("file", .string(plain.lastPathComponent)), ("format", .string("plain SQLite"))]),
            .object([("file", .string(sealed.lastPathComponent)), ("format", .string("GWBK")),
                     ("iterations", .int(Int64(BackupEncryption.iterations)))]),
            .object([("file", .string(legacy.lastPathComponent)), ("format", .string("SJNL (older)"))]),
        ])),
        ("trades", .int(Int64(try repo.count()))),
        ("tickets", refEncode(try repo.fetchAll().map { String($0.ticket) })),
    ])
}

/// Greenwick-specific probes: how the import parser reads ET wall-clock times around DST, and
/// how the trading calendar sizes those days.
@MainActor
func refBrandProbes() -> RefJSON {
    let texts: [(String, String)] = [
        ("03/08/2026 02:30:00", "MM/dd/yyyy HH:mm:ss"), ("11/01/2026 01:30:00", "MM/dd/yyyy HH:mm:ss"),
        ("3/8/2026", "M/d/yyyy"), ("11/1/2026", "M/d/yyyy"), ("2026-03-08T02:30:00Z", "yyyy-MM-dd'T'HH:mm:ssZ"),
        ("06/30/2026 10:00:00 EDT", "MM/dd/yyyy HH:mm:ss"), ("03/08/26", "MM/dd/yy"),
    ]
    let days = ["2026-03-08", "2026-11-01", "2026-06-15"]
    return .object([
        ("parseDateTime", .array(texts.map { t, f in
            .object([("text", .string(t)), ("format", .string(f)),
                     ("utc", GenericCSVParser.parseDateTime(t, format: f).map { .string(RefFormat.iso.string(from: $0)) } ?? .null)])
        })),
        ("tradingDays", .array(days.compactMap { key -> RefJSON? in
            guard let start = TradingCalendar.date(fromDayKey: key) else { return nil }
            let next = TradingCalendar.calendar.date(byAdding: .day, value: 1, to: start) ?? start
            return .object([("dayKey", .string(key)), ("start", .string(RefFormat.iso.string(from: start))),
                            ("hours", refDouble(next.timeIntervalSince(start) / 3600)),
                            ("roundTrip", .string(TradingCalendar.dayKey(start)))])
        })),
    ])
}
