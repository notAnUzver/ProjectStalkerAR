ns.modules.define('cloud.dataSyncApi.DatasetController', [
    'cloud.dataSyncApi.config',
    'cloud.dataSyncApi.http',
    'cloud.dataSyncApi.Dataset',
    'cloud.dataSyncApi.cache',
    'cloud.Error',
    'component.util',
    'vow'
], function (provide,
     config, http, Dataset, cache, Error,
     util, vow) {

    /**
     * @ignore
     * @class Контроллер набора данных, создаёт и обновляет
     * {@link cloud.dataSyncApi.Dataset} и следит за локальным кэшированием.
     * @name cloud.dataSyncApi.DatasetController
     */
    var DatasetController = function (options) {
            this._options = options || {};
            this._gone = false;
            this._updatePromise = null;
            this._dataset = null;
            return this._createDataset().then(function () {
                return this;
            }, null, this);
        };

    DatasetController.create = function (options) {
        return new DatasetController(options);
    };

    util.defineClass(DatasetController, /** @lends cloud.dataSyncApi.DatasetController */{
        getDataset: function () {
            return this._dataset;
        },

        isGone: function () {
            return this._gone;
        },

        close: function () {
            this._onGone();
        },

        _createDataset: function () {
            return http.putDatabase(this._options).then(function (res) {
                if (res.code != 200 && res.code != 201) {
                    throw new Error({
                        code: res.code
                    });
                } else {
                    return this._getSnapshot(res.data);
                }
            }, null, this);
        },

        _getSnapshot: function (metadata) {
            var options = this._options,
                handle = this._databaseHandle = metadata.handle;

            if (handle && options.use_client_storage) {
                return cache.getDataset(options.context, handle, options.collection_id).then(function (dataset) {
                    return this._initDataset(dataset, {
                        need_update: true
                    });
                }, function () {
                    return this._getHttpSnapshot();
                }, this);
            } else {
                return this._getHttpSnapshot();
            }
        },

        _getHttpSnapshot: function () {
            return http.getSnapshot(this._options).then(function (res) {
                if (res.code == 200) {
                    return this._initDataset(Dataset.json.deserialize(
                        res.data, {
                            collection_id: this._options.collection_id
                        }
                    ));
                } else {
                    throw new Error({
                        code: res.code
                    });
                }
            }, null, this);
        },

        _initDataset: function (dataset, parameters) {
            this._dataset = dataset;

            if (parameters && parameters.need_update) {
                return this.update().fail(function (e) {
                    if (e.code == 410) {
                        deferred.resolve(this._getHttpSnapshot(options));
                    } else {
                        deferred.reject(e);
                    }
                }, this);
            } else {
                return this._saveSnapshot().always(function () {
                    return vow.resolve();
                });
            }
        },

        _saveSnapshot: function () {
            if (this._options.use_client_storage && this._databaseHandle) {
                return cache.saveDataset(
                    this._options.context,
                    this._databaseHandle,
                    this._dataset
                );
            } else {
                return vow.resolve();
            }
        },

        update: function (parameters) {
            if (this._gone) {
                return this._gone;
            } else if (!this._updatePromise) {
                this._updatePromise = this._applyDeltas(parameters).then(function (res) {
                    return this._saveSnapshot().always(function () {
                        this._updatePromise = null;
                        return res;
                    }, this);
                }, function (e) {
                    if (e.code == 410) {
                        this._onGone();
                    }
                    this._updatePromise = null;
                    throw e;
                }, this);
            }

            return this._updatePromise;
        },

        _applyDeltas: function (parameters) {
            var dataset = this._dataset;

            return getDeltas(this._options, dataset.getRevision()).then(function (deltas) {
                if (deltas.length) {
                    dataset.applyDeltas(deltas);
                }

                var missedDeltaFound = false;
                if (parameters && parameters.possiblyMissedDelta) {
                    deltas.forEach(function (delta) {
                        if (delta.delta_id == parameters.possiblyMissedDelta) {
                            missedDeltaFound = true;
                        }
                    })
                }

                return {
                    revision: dataset.getRevision(),
                    missedDeltaFound: missedDeltaFound
                };
            });
        },

        _onGone: function () {
            this._gone = vow.reject({
                code: 410,
                message: 'Database snapshot outdated'
            });
        }
    });

    function getDeltas (options, baseRevision) {
        var deltas = [],
            deferred = vow.defer(),

            fail = function (e) {
                deferred.reject(e);
            },

            getChunk = function (baseRevision) {
                return http.getDeltas(util.extend({}, options, {
                    base_revision: baseRevision,
                    limit: config.deltaLimit
                })).then(function (res) {
                    if (res.code == 200) {
                        return res.data;
                    } else {
                        throw new Error({
                            code: res.code
                        });
                    }
                });
            },

            onChunk = function (data) {
                var targetRevision = data.revision;
                deltas.push(data.items);

                var recievedRevision = data.items.length ?
                        data.items[data.items.length - 1].revision :
                        targetRevision;

                if (recievedRevision == targetRevision) {
                    onEnd();
                } else {
                    getChunk(recievedRevision).then(onChunk, fail);
                }
            },

            onEnd = function () {
                deltas = [].concat.apply([], deltas);
                deferred.resolve(deltas);
            };

        getChunk(baseRevision).then(onChunk, fail);

        return deferred.promise();
    }

    provide(DatasetController);
});
