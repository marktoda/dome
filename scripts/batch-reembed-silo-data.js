"use strict";
/**
 * Batch Re-Embedding Script for Silo Data
 *
 * This script triggers re-embedding and re-AI processing of all content in Silo.
 * It queries all content from the D1 database, then sends messages to the NEW_CONTENT queues
 * to trigger re-embedding by Constellation and AI services.
 *
 * Usage:
 *   cd /home/toda/dev/dome
 *   npx tsx scripts/batch-reembed-silo-data.ts [--batchSize=100] [--dryRun] [--help]
 *
 * Options:
 *   --batchSize=<number>  Number of items to process in each batch (default: 100)
 *   --dryRun              Run without actually sending messages to queues
 *   --help                Show this help message
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var logging_1 = require("@dome/logging");
var child_process_1 = require("child_process");
var util_1 = require("util");
var fs = require("fs");
// Initialize logger
var logger = (0, logging_1.getLogger)();
// Helper for executing commands
var execAsync = (0, util_1.promisify)(child_process_1.exec);
// Parse command line arguments manually
function parseArgs() {
    var args = {
        batchSize: 100,
        dryRun: false,
        help: false
    };
    process.argv.slice(2).forEach(function (arg) {
        if (arg.startsWith('--batchSize=')) {
            args.batchSize = parseInt(arg.split('=')[1], 10);
        }
        else if (arg === '--dryRun' || arg === '-d') {
            args.dryRun = true;
        }
        else if (arg === '--help' || arg === '-h') {
            args.help = true;
        }
    });
    return args;
}
var args = parseArgs();
// Show help if requested
if (args.help) {
    console.log("\n  Batch Re-Embedding Script for Silo Data\n\n  This script triggers re-embedding and re-AI processing of all content in Silo.\n\n  Usage:\n    cd /home/toda/dev/dome\n    npx tsx scripts/batch-reembed-silo-data.ts [--batchSize=100] [--dryRun] [--help]\n\n  Options:\n    --batchSize=<number>  Number of items to process in each batch (default: 100)\n    --dryRun              Run without actually sending messages to queues\n    --help                Show this help message\n  ");
    process.exit(0);
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var sqlFile, stdout, results, contentItems, totalBatches, processedCount, successCount, failureCount, batchIndex, start, end, batch, _i, batch_1, item, message, messageJson, error_1, percentComplete, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger.info("Starting batch re-embedding process".concat(args.dryRun ? ' (DRY RUN)' : ''));
                    logger.info("Batch size: ".concat(args.batchSize));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 16, , 17]);
                    // Use wrangler CLI commands instead of importing wrangler
                    logger.info('Querying content from Silo database...');
                    sqlFile = './temp-query-silo-contents.sql';
                    fs.writeFileSync(sqlFile, 'SELECT * FROM contents;');
                    return [4 /*yield*/, execAsync('npx wrangler d1 execute silo --file=./temp-query-silo-contents.sql --json')];
                case 2:
                    stdout = (_a.sent()).stdout;
                    // Clean up the temporary file
                    fs.unlinkSync(sqlFile);
                    results = JSON.parse(stdout);
                    contentItems = results[0].results || [];
                    if (!contentItems || contentItems.length === 0) {
                        logger.warn('No content found in Silo database.');
                        return [2 /*return*/];
                    }
                    logger.info("Found ".concat(contentItems.length, " content items to process"));
                    totalBatches = Math.ceil(contentItems.length / args.batchSize);
                    processedCount = 0;
                    successCount = 0;
                    failureCount = 0;
                    batchIndex = 0;
                    _a.label = 3;
                case 3:
                    if (!(batchIndex < totalBatches)) return [3 /*break*/, 15];
                    start = batchIndex * args.batchSize;
                    end = Math.min(start + args.batchSize, contentItems.length);
                    batch = contentItems.slice(start, end);
                    logger.info("Processing batch ".concat(batchIndex + 1, "/").concat(totalBatches, " (items ").concat(start + 1, "-").concat(end, ")"));
                    _i = 0, batch_1 = batch;
                    _a.label = 4;
                case 4:
                    if (!(_i < batch_1.length)) return [3 /*break*/, 12];
                    item = batch_1[_i];
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 9, , 10]);
                    message = {
                        id: item.id,
                        userId: item.userId,
                        category: item.contentType || 'note',
                    };
                    if (!!args.dryRun) return [3 /*break*/, 8];
                    // Use wrangler CLI to send messages to queues
                    logger.info("Sending message for content ID: ".concat(item.id));
                    messageJson = JSON.stringify(message);
                    fs.writeFileSync('./temp-message.json', messageJson);
                    // Send to both queues
                    return [4 /*yield*/, execAsync('npx wrangler queues publish new-content-constellation ./temp-message.json')];
                case 6:
                    // Send to both queues
                    _a.sent();
                    return [4 /*yield*/, execAsync('npx wrangler queues publish new-content-ai ./temp-message.json')];
                case 7:
                    _a.sent();
                    // Clean up
                    fs.unlinkSync('./temp-message.json');
                    _a.label = 8;
                case 8:
                    logger.debug("Sent message for content ID: ".concat(item.id));
                    successCount++;
                    return [3 /*break*/, 10];
                case 9:
                    error_1 = _a.sent();
                    logger.error({ error: error_1, contentId: item.id }, "Failed to send message for content ID: ".concat(item.id));
                    failureCount++;
                    return [3 /*break*/, 10];
                case 10:
                    processedCount++;
                    // Log progress every 10% of total
                    if (processedCount % Math.max(1, Math.floor(contentItems.length / 10)) === 0) {
                        percentComplete = ((processedCount / contentItems.length) * 100).toFixed(1);
                        logger.info("Progress: ".concat(percentComplete, "% (").concat(processedCount, "/").concat(contentItems.length, ")"));
                    }
                    _a.label = 11;
                case 11:
                    _i++;
                    return [3 /*break*/, 4];
                case 12:
                    logger.info("Completed batch ".concat(batchIndex + 1, "/").concat(totalBatches));
                    if (!(batchIndex < totalBatches - 1)) return [3 /*break*/, 14];
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1000); })];
                case 13:
                    _a.sent();
                    _a.label = 14;
                case 14:
                    batchIndex++;
                    return [3 /*break*/, 3];
                case 15:
                    // Log final summary
                    logger.info('===== Batch Re-Embedding Summary =====');
                    logger.info("Total content items: ".concat(contentItems.length));
                    logger.info("Successfully processed: ".concat(successCount));
                    logger.info("Failed to process: ".concat(failureCount));
                    logger.info("".concat(args.dryRun ? '[DRY RUN] No actual messages were sent' : 'All messages sent successfully'));
                    logger.info('======================================');
                    return [3 /*break*/, 17];
                case 16:
                    error_2 = _a.sent();
                    logger.error({ error: error_2 }, 'Failed to complete batch re-embedding process');
                    process.exit(1);
                    return [3 /*break*/, 17];
                case 17: return [2 /*return*/];
            }
        });
    });
}
// Execute main function
main().catch(function (error) {
    logger.error({ error: error }, 'Unhandled error in batch re-embedding script');
    process.exit(1);
});
