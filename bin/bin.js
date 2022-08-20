#!/usr/bin/env node

import fs from "fs";
import _path from "path";
import commander from "commander";
import { createRequire } from "module";
import pluralize from "pluralize";

import { download } from "./async.js";
import {
  getArchiveKey,
  getFeed,
  getImageUrl,
  getItemsToDownload,
  getUrlExt,
  logFeedInfo,
  logItemsList,
  writeFeedMeta,
  ITEM_LIST_FORMATS,
  METADATA_FORMATS,
} from "./util.js";
import { createParseNumber, hasFfmpeg } from "./validate.js";
import {
  ERROR_STATUSES,
  LOG_LEVELS,
  logMessage,
  logError,
  logErrorAndExit,
} from "./logger.js";
import { getFolderName, getSafeName } from "./naming.js";
import { downloadItemsAsync } from "./async.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const collect = (value, previous) => {
  if (!previous) {
    previous = [];
  }
  return previous.concat([value]);
};

commander
  .version(version)
  .option("--url <string>", "url to podcast rss feed")
  .option("--out-dir <path>", "specify output directory", "./{{podcast_title}}")
  .option(
    "--archive [path]",
    "download or write only items not listed in archive file"
  )
  .option(
    "--episode-template <string>",
    "template for generating episode related filenames",
    "{{release_date}}-{{title}}"
  )
  .option("--include-meta [rule]", "write out podcast metadata", collect)
  .option(
    "--include-episode-meta [rule]",
    "write out individual episode metadata",
    collect
  )
  .option(
    "--metadata-format [json|xml]",
    "the format to use for the podcast/episode metadata",
    (value) => {
      if (value !== METADATA_FORMATS.json && value !== METADATA_FORMATS.xml) {
        logErrorAndExit(
          `${value} is an invalid format for --metadata-format\nUse "json" or "xml"`
        );
      }

      return value;
    },
    METADATA_FORMATS.json
  )
  .option("--include-episode-transcripts", "download found episode transcripts")
  .option("--include-episode-images", "download found episode images")
  .option(
    "--offset <number>",
    "offset episode to start downloading from (most recent = 0)",
    createParseNumber({ min: 0, name: "--offset" }),
    0
  )
  .option(
    "--limit <number>",
    "max amount of episodes to download",
    createParseNumber({ min: 1, name: "--limit", require: false })
  )
  .option(
    "--episode-regex <string>",
    "match episode title against regex before downloading"
  )
  .option(
    "--after <string>",
    "download episodes only after this date (inclusive)"
  )
  .option(
    "--before <string>",
    "download episodes only before this date (inclusive)"
  )
  .option(
    "--add-mp3-metadata",
    "attempts to add a base level of metadata to .mp3 files using ffmpeg",
    hasFfmpeg
  )
  .option(
    "--adjust-bitrate <string>",
    "attempts to adjust bitrate of .mp3 files using ffmpeg",
    hasFfmpeg
  )
  .option(
    "--mono",
    "attempts to force .mp3 files into mono using ffmpeg",
    hasFfmpeg
  )
  .option("--override", "override local files on collision")
  .option("--reverse", "download episodes in reverse order")
  .option("--info", "print retrieved podcast info instead of downloading")
  .option(
    "--list [table|json]",
    "print episode info instead of downloading",
    (value) => {
      if (
        value !== ITEM_LIST_FORMATS.table &&
        value !== ITEM_LIST_FORMATS.json
      ) {
        logErrorAndExit(
          `${value} is an invalid format for --list\nUse "table" or "json"`
        );
      }

      return value;
    }
  )
  .option(
    "--exec <string>",
    "Execute a command after each episode is downloaded"
  )
  .option(
    "--threads <number>",
    "the number of downloads that can happen concurrently",
    createParseNumber({ min: 1, max: 32, name: "threads" }),
    1
  )
  .option(
    "--filter-url-tracking",
    "attempts to extract the direct download link of an episode if detected (experimental)"
  )
  .parse(process.argv);

const {
  url,
  outDir,
  episodeTemplate,
  includeMeta,
  includeEpisodeMeta,
  includeEpisodeTranscripts,
  includeEpisodeImages,
  metadataFormat,
  offset,
  limit,
  episodeRegex,
  after,
  before,
  override,
  reverse,
  info,
  list,
  exec,
  mono,
  threads,
  filterUrlTracking,
  addMp3Metadata: addMp3MetadataFlag,
  adjustBitrate: bitrate,
} = commander;

let { archive } = commander;

const getFieldOptionValue = (value, defaultValue) => {
  // If the option hasn't been provided the value is falsy (undefined).
  if (!value) {
    return value;
  }
  // If the option has been provided with an argument the value is an array.
  if (Array.isArray(value)) {
    return value;
  }
  // If the option has been provided without an argument the value is truthy (true).
  return defaultValue;
};

const main = async () => {
  if (!url) {
    logErrorAndExit("No URL provided");
  }

  const { hostname, pathname } = new URL(url);
  const archiveUrl = `${hostname}${pathname}`;
  const feed = await getFeed(url);
  const basePath = _path.resolve(
    process.cwd(),
    getFolderName({ feed, template: outDir })
  );

  logFeedInfo(feed);

  if (list) {
    if (feed.items && feed.items.length) {
      const listFormat = typeof list === "boolean" ? "table" : list;
      logItemsList({
        type: listFormat,
        feed,
        limit,
        offset,
        reverse,
        after,
        before,
        episodeRegex,
      });
    } else {
      logErrorAndExit("No episodes found to list");
    }
  }

  if (info || list) {
    process.exit(0);
  }

  if (!fs.existsSync(basePath)) {
    logMessage(`${basePath} does not exist. Creating...`, LOG_LEVELS.important);
    fs.mkdirSync(basePath, { recursive: true });
  }

  if (archive) {
    archive =
      typeof archive === "boolean"
        ? "./{{podcast_title}}/archive.json"
        : archive;
    archive = getFolderName({ feed, template: archive });
  }

  if (includeMeta) {
    const podcastImageUrl = getImageUrl(feed);

    if (podcastImageUrl) {
      const podcastImageFileExt = getUrlExt(podcastImageUrl);
      const podcastImageName = `${
        feed.title ? `${feed.title}.image` : "image"
      }${podcastImageFileExt}`;
      const outputImagePath = _path.resolve(
        basePath,
        getSafeName(podcastImageName)
      );

      try {
        logMessage("\nDownloading podcast image...");
        await download({
          archive,
          override,
          marker: podcastImageUrl,
          key: getArchiveKey({ prefix: archiveUrl, name: podcastImageName }),
          outputPath: outputImagePath,
          url: podcastImageUrl,
        });
      } catch (error) {
        logError("Unable to download podcast image", error);
      }
    }

    const outputMetaName = `${
      feed.title ? `${feed.title}.meta` : "meta"
    }.${metadataFormat}`;
    const outputMetaPath = _path.resolve(basePath, getSafeName(outputMetaName));

    try {
      logMessage("\nSaving podcast metadata...");
      writeFeedMeta({
        archive,
        override,
        feed,
        fields: getFieldOptionValue(includeMeta, [
          "title",
          "description",
          "link",
          "feedUrl",
          "managingEditor",
        ]),
        key: getArchiveKey({ prefix: archiveUrl, name: outputMetaName }),
        outputPath: outputMetaPath,
      });
    } catch (error) {
      logError("Unable to save podcast metadata", error);
    }
  }

  if (!feed.items || feed.items.length === 0) {
    logErrorAndExit("No episodes found to download");
  }

  if (offset >= feed.items.length) {
    logErrorAndExit("--offset too large. No episodes to download.");
  }

  const targetItems = getItemsToDownload({
    archive,
    archiveUrl,
    basePath,
    feed,
    limit,
    offset,
    reverse,
    after,
    before,
    episodeRegex,
    episodeTemplate,
    includeEpisodeTranscripts,
    includeEpisodeImages,
  });

  if (!targetItems.length) {
    logErrorAndExit("No episodes found with provided criteria to download");
  }

  logMessage(
    `\nStarting download of ${pluralize("episode", targetItems.length, true)}\n`
  );

  const { numEpisodesDownloaded, hasErrors } = await downloadItemsAsync({
    addMp3MetadataFlag,
    archive,
    archiveUrl,
    basePath,
    bitrate,
    episodeTemplate,
    exec,
    feed,
    fields: getFieldOptionValue(includeEpisodeMeta, [
      "title",
      "contentSnippet",
      "pubDate",
      "creator",
    ]),
    metadataFormat,
    mono,
    override,
    targetItems,
    threads,
    filterUrlTracking,
  });

  if (hasErrors && numEpisodesDownloaded !== targetItems.length) {
    logMessage(
      `\n${numEpisodesDownloaded} of ${pluralize(
        "episode",
        targetItems.length,
        true
      )} downloaded\n`
    );
  } else if (numEpisodesDownloaded > 0) {
    logMessage(
      `\nSuccessfully downloaded ${pluralize(
        "episode",
        numEpisodesDownloaded,
        true
      )}\n`
    );
  }

  if (numEpisodesDownloaded === 0) {
    process.exit(ERROR_STATUSES.nothingDownloaded);
  }

  if (hasErrors) {
    process.exit(ERROR_STATUSES.completedWithErrors);
  }
};

main();
