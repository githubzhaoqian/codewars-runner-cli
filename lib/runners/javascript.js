var shovel = require('../shovel'),
    util = require('../util'),
    config = require('../config'),
    temp = require('temp'),
    exec = require('child_process').exec,
	frontendFrameworks = require('../frontend-frameworks');


module.exports.run = function run(opts, cb)
{
    shovel.start(opts, cb, {
        solutionOnly: function (runCode, fail)
        {
            var code = opts.solution;

            if (opts.setup)
                code = opts.setup + ';\n' + code;

            includeOptionsFiles(opts);
            execNode(opts, code, runCode, fail);
        },
        testIntegration: function (runCode, fail)
        {
            switch (opts.testFramework)
            {
                case 'cw': // for backwards compatibility, all legacy CW challenges have been updated to use cw-2
                case 'cw-2':
                    return prepareCw2(opts, runCode, fail);

                case 'mocha':
                case 'mocha_bdd':
                    return prepareMocha(opts, 'bdd', runCode, fail);

                case 'mocha_tdd':
                    return prepareMocha(opts, 'tdd', runCode, fail);

                case 'karma':
                case 'karma_bdd':
                    return prepareKarma(opts, 'bdd', runCode, fail);

                case 'karma_tdd':
                    return prepareKarma(opts, 'tdd', runCode, fail);

                default:
                    throw 'Test framework is not supported'
            }
        },
        sanitizeStdErr: function(error)
        {
            error = error || ''
            return error.replace(/(\()?\/codewars\/[(\w\/-\d.js:) ;]*/g, '')
                        .replace(/( Object. )?[\(]?\[eval\][-:\w\d\)]* at/g, '')
                        .replace(/Module._compile.*/g, '')
                        .replace('Object.Test.handleError ', '')
                        .replace('  ', ' ')
                        .replace(opts.setup || '', '')
                        .replace(opts.fixture || '', '');
        },
        sanitizeStdOut: function(stdout)
        {
            return this.sanitizeStdErr(stdout);
        }
    });
};

function prepareMocha(opts, interfaceType, runCode) {
    var code = `
        ${opts.setup};
        ${opts.solution};
        (function() {
            ${opts.fixture};
        })();
    `;

    // currently mocha is the only framework to provide option files support
    includeOptionsFiles(opts);

    // run tests inline to the context but within their own scope. Redefine the key test methods in case they were
    // locally redefined within the solution.
    var solutionFile = util.codeWriteSync('javascript', maybeTransform(code, opts), opts.dir, 'mocha', true);
    
    // NOTE: Mocha based testing currently does not support Node versioning
    runCode({name: 'mocha', 'args': ['-t', opts.timeout || 8000, '-u', interfaceType, '-R', 'mocha-reporter', solutionFile]});
}

function prepareKarma(opts, interfaceType, runCode, fail) {
	var dir = opts.dir;

    // files to load into Karma
	var files = [];
    // handle includes
    var includeMatches = (opts.setup || '').match(/@include-external\s+\S+/g);
    if(includeMatches) {
	    includeMatches.forEach(match => {
		    let name = match.replace(/@include-external\s+/, '');
		    files.push(...frontendFrameworks.find(name));
	    });
    }
    // handle core code
    ['setup', 'solution', 'fixture'].forEach(function(type) {
        if(opts[type] && opts[type].length) {
            // always transform this code, it ends up in the browser:
            var code = transform(opts[type] || '', '0.10.x', type + '.js');
            files.push(util.codeWriteSync('javascript', code, dir, type + '.js', true));
        }
	});

    var config = {
	      files: files,
        singleRun: true,
	      autoWatch: false,
	      retryLimit: 0,
        frameworks: ['mocha', 'chai'],
	      browsers: ['PhantomJS'],
        plugins: ['karma-*', '/runner/frameworks/javascript/karma-coderunner-reporter.js'],
        reporters: ['coderunner'],
	      logLevel: 'warn',
        client: {
            mocha: {
              timeout: opts.timeout || 8000,
              ui: interfaceType,
            },
        },
    };

    var code = `
        var KarmaServer = require('karma').Server;
        var karma = new KarmaServer(${ JSON.stringify(config, null, 4) }, function(code) {
            process.exit(code);
        });
        karma.start();
    `;

    execNode(opts, code, runCode, fail);
}

function prepareCw2(opts, runCode, fail)
{
    // run tests inline to the context but within their own scope. Redefine the key test methods in case they were
    // locally redefined within the solution.
    var code = `
        require('/runner/frameworks/javascript/cw-2');
        var assert = require('assert');
        Test.handleError(function(){
            ${opts.setup};
            ${opts.solution};
            (function() {
                var Test = global.Test, describe = global.describe, it = global.it, before = global.before, after = global.after;
                ${opts.fixture};
            })();
        });
    `;

    includeOptionsFiles(opts, '/home/codewarrior');

    execNode(opts, code, runCode, fail);
}

function execNode(opts, code, runCode, fail) {
    try {
        var version = versionInfo(opts);
        code = maybeTransform(code, opts);

        var args = ['-e', code, '--no-deprecation'];
        // if (version.name == '6.x') {
        //     args.push('--trace-warnings');
        // }

        (opts.requires || []).forEach(function (f) {
            args.push("--require");
            args.push(f);
        });
        runCode({
            name: `/usr/local/n/versions/node/${version.node}/bin/node`,
            args: args
        });
    }
    catch(ex) {
        fail(ex);
    }
}

// a files object/hash can be passed in as options, which will be transformed (if applicable) and then stored
// in the provided directory.
function includeOptionsFiles(opts, dir) {
    // write files that may have been included to the file system, within the directory that the code executes in
    util.writeFilesSync(dir || '/home/codewarrior', opts.files, true, function(name, content) {
        return /\.js$/.test(name) ? maybeTransform(content, opts) : content;
    });
}

function nodeVersion(version) {
    switch(version) {
        case "6.x":
            return "6.6.0";
        case "0.10.x":
            return "0.10.33"
        default:
            return version;
    }
}

// returns information about the version passed in, such as its node version and if babel is enabled
function versionInfo(opts) {
    var info = {
        name: (opts.languageVersion || '6.x').split('/')[0],
        babel: opts.languageVersion && opts.languageVersion.split('/')[1] == 'babel'
    }

    info.node = nodeVersion(info.name);
    return info;
}

// will babel transform the code if babel is configured, otherwise will just return the code unaltered.
function maybeTransform(code, opts, filename) {
    var version = versionInfo(opts);

    if (version.babel) {
        return transform(code, version.name, filename);
    }
    else {
        return code;
    }
}

function transform(code, version, filename) {
    try {
        switch (version) {
            case '0.10.x':
                return require('babel-core').transform(code, {
                    presets: ["stage-1", "react"],
                    plugins: [
                        "check-es2015-constants",
                        "angular2-annotations",
                        "transform-decorators-legacy",
                        "transform-class-properties",
                        "transform-flow-strip-types",
                        "transform-es2015-arrow-functions",
                        "transform-es2015-block-scoped-functions",
                        "transform-es2015-block-scoping",
                        "transform-es2015-classes",
                        "transform-es2015-computed-properties",
                        "transform-es2015-destructuring",
                        "transform-es2015-duplicate-keys",
                        "transform-es2015-for-of",
                        "transform-es2015-function-name",
                        "transform-es2015-literals",
                        "transform-es2015-object-super",
                        "transform-es2015-parameters",
                        "transform-es2015-shorthand-properties",
                        "transform-es2015-spread",
                        "transform-es2015-sticky-regex",
                        "transform-es2015-template-literals",
                        "transform-es2015-typeof-symbol",
                        "transform-es2015-unicode-regex",
                        "transform-regenerator",
                    ],
                    ast: false,
                    filename: filename || 'kata.js'
                }).code;

            default:
                return require('babel-core').transform(code, {
                    presets: ["stage-1", "node5", "react"],
                    plugins: [
                        "angular2-annotations",
                        "transform-decorators-legacy",
                        "transform-class-properties",
                        "transform-flow-strip-types",
                    ],
                    ast: false,
                    filename: filename || 'kata.js'
                }).code;


        }
    }
    catch(ex) {
        var msg = ex.message;
        // if (ex.loc) {
        //     // replace the line number since it is not what the user sees
        //     msg = msg.replace(/ \(\d*:\d*\)/, ":" + ex.loc.column)
        //     var lines = code.split('\n');
        //     msg += "\n" + lines[ex.loc.line - 1];
        //     msg += "\n";
        //     for(var i = 1;i < ex.loc.column; i++) {
        //         msg += ' ';
        //     }
        //     msg += '^';
        // }
        throw new shovel.CompileError(msg);
    }
}
