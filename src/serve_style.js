'use strict';

import path from 'path';
import fs from 'node:fs';

import clone from 'clone';
import express from 'express';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { fixUrl, allowedOptions } from './utils.js';

const httpTester = /^https?:\/\//i;
const allowedSpriteFormats = allowedOptions(['png', 'json']);

/**
 * Checks and formats sprite scale
 * @param {string} scale string containing the scale
 * @returns {string} formated string for the scale or empty string if scale is invalid
 */
function allowedSpriteScales(scale) {
  if (!scale) return ''; // Default to 1 if no scale provided
  const match = scale.match(/(\d+)x/); // Match one or more digits before 'x'
  const parsedScale = match ? parseInt(match[1], 10) : 1; // Parse the number, or default to 1 if no match
  return '@' + Math.min(parsedScale, 3) + 'x';
}

export const serve_style = {
  /**
   * Initializes the serve_style module.
   * @param {object} options Configuration options.
   * @param {object} repo Repository object.
   * @returns {express.Application} The initialized Express application.
   */
  init: function (options, repo) {
    const app = express().disable('x-powered-by');

    app.get('/:id/style.json', (req, res, next) => {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }
      const styleJSON_ = clone(item.styleJSON);
      for (const name of Object.keys(styleJSON_.sources)) {
        const source = styleJSON_.sources[name];
        source.url = fixUrl(req, source.url, item.publicUrl);
        if (typeof source.data == 'string') {
          source.data = fixUrl(req, source.data, item.publicUrl);
        }
      }
      // mapbox-gl-js viewer cannot handle sprite urls with query
      if (styleJSON_.sprite) {
        if (Array.isArray(styleJSON_.sprite)) {
          styleJSON_.sprite.forEach((spriteItem) => {
            spriteItem.url = fixUrl(req, spriteItem.url, item.publicUrl);
          });
        } else {
          styleJSON_.sprite = fixUrl(req, styleJSON_.sprite, item.publicUrl);
        }
      }
      if (styleJSON_.glyphs) {
        styleJSON_.glyphs = fixUrl(req, styleJSON_.glyphs, item.publicUrl);
      }
      return res.send(styleJSON_);
    });

    app.get(`/:id/:sprite{/:spriteID}{@:scale}{.:format}`, (req, res, next) => {
      console.log(req.params);
      const { spriteID = 'default', id, format } = req.params;
      const scale = allowedSpriteScales(req.params.scale);
      try {
        if (
          !allowedSpriteFormats(format) ||
          ((id == 256 || id == 512) && format === 'json')
        ) {
          //Workaround for {/:tileSize}/:id.json' and /styles/:id/wmts.xml
          next('route');
        } else {
          const item = repo[id];
          const sprite = item.spritePaths.find(
            (sprite) => sprite.id === spriteID,
          );
          if (sprite) {
            const filename = `${sprite.path + scale}.${format}`;
            return fs.readFile(filename, (err, data) => {
              if (err) {
                console.log('Sprite load error:', filename);
                return res.sendStatus(404);
              } else {
                if (format === 'json')
                  res.header('Content-type', 'application/json');
                if (format === 'png') res.header('Content-type', 'image/png');
                return res.send(data);
              }
            });
          } else {
            return res.status(400).send('Bad Sprite ID or Scale');
          }
        }
      } catch (e) {
        console.log(e);
        next('route');
      }
    });

    return app;
  },
  /**
   * Removes an item from the repository.
   * @param {object} repo Repository object.
   * @param {string} id ID of the item to remove.
   * @returns {void}
   */
  remove: function (repo, id) {
    delete repo[id];
  },
  /**
   * Adds a new style to the repository.
   * @param {object} options Configuration options.
   * @param {object} repo Repository object.
   * @param {object} params Parameters object containing style path
   * @param {string} id ID of the style.
   * @param {string} publicUrl Public URL of the data.
   * @param {Function} reportTiles Function for reporting tile sources.
   * @param {Function} reportFont Function for reporting font usage
   * @returns {boolean} true if add is succesful
   */
  add: function (
    options,
    repo,
    params,
    id,
    publicUrl,
    reportTiles,
    reportFont,
  ) {
    const styleFile = path.resolve(options.paths.styles, params.style);

    let styleFileData;
    try {
      styleFileData = fs.readFileSync(styleFile); // TODO: could be made async if this function was
    } catch (e) {
      console.log(`Error reading style file "${params.style}"`);
      return false;
    }

    const styleJSON = JSON.parse(styleFileData);
    const validationErrors = validateStyleMin(styleJSON);
    if (validationErrors.length > 0) {
      console.log(`The file "${params.style}" is not a valid style file:`);
      for (const err of validationErrors) {
        console.log(`${err.line}: ${err.message}`);
      }
      return false;
    }

    for (const name of Object.keys(styleJSON.sources)) {
      const source = styleJSON.sources[name];
      let url = source.url;
      if (
        url &&
        (url.startsWith('pmtiles://') || url.startsWith('mbtiles://'))
      ) {
        const protocol = url.split(':')[0];

        let dataId = url.replace('pmtiles://', '').replace('mbtiles://', '');
        if (dataId.startsWith('{') && dataId.endsWith('}')) {
          dataId = dataId.slice(1, -1);
        }

        const mapsTo = (params.mapping || {})[dataId];
        if (mapsTo) {
          dataId = mapsTo;
        }

        const identifier = reportTiles(dataId, protocol);
        if (!identifier) {
          return false;
        }
        source.url = `local://data/${identifier}.json`;
      }

      let data = source.data;
      if (data && typeof data == 'string' && data.startsWith('file://')) {
        source.data =
          'local://files' +
          path.resolve(
            '/',
            data.replace('file://', '').replace(options.paths.files, ''),
          );
      }
    }

    for (const obj of styleJSON.layers) {
      if (obj['type'] === 'symbol') {
        const fonts = (obj['layout'] || {})['text-font'];
        if (fonts && fonts.length) {
          fonts.forEach(reportFont);
        } else {
          reportFont('Open Sans Regular');
          reportFont('Arial Unicode MS Regular');
        }
      }
    }

    let spritePaths = [];
    if (styleJSON.sprite) {
      if (!Array.isArray(styleJSON.sprite)) {
        if (!httpTester.test(styleJSON.sprite)) {
          let spritePath = path.join(
            options.paths.sprites,
            styleJSON.sprite
              .replace('{style}', path.basename(styleFile, '.json'))
              .replace(
                '{styleJsonFolder}',
                path.relative(options.paths.sprites, path.dirname(styleFile)),
              ),
          );
          styleJSON.sprite = `local://styles/${id}/sprite`;
          spritePaths.push({ id: 'default', path: spritePath });
        }
      } else {
        for (let spriteItem of styleJSON.sprite) {
          if (!httpTester.test(spriteItem.url)) {
            let spritePath = path.join(
              options.paths.sprites,
              spriteItem.url
                .replace('{style}', path.basename(styleFile, '.json'))
                .replace(
                  '{styleJsonFolder}',
                  path.relative(options.paths.sprites, path.dirname(styleFile)),
                ),
            );
            spriteItem.url = `local://styles/${id}/sprite/` + spriteItem.id;
            spritePaths.push({ id: spriteItem.id, path: spritePath });
          }
        }
      }
    }

    if (styleJSON.glyphs && !httpTester.test(styleJSON.glyphs)) {
      styleJSON.glyphs = 'local://fonts/{fontstack}/{range}.pbf';
    }

    repo[id] = {
      styleJSON,
      spritePaths,
      publicUrl,
      name: styleJSON.name,
    };

    return true;
  },
};
