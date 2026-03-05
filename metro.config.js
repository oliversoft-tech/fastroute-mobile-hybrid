const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('xlsx')) {
  config.resolver.assetExts.push('xlsx');
}

module.exports = config;
