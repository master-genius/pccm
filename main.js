/**
    pccm Copyright (C) 2019.08 BraveWang
    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License , or
    (at your option) any later version.
*/
'use strict';

const fs = require('fs');
const cluster = require('cluster');
const os = require('os');
const {spawn} = require('child_process');
const net = require('net');


/**
 * @param {object} options 初始化选项，参考值如下：
 */
var pccm = function (options = {}) {
    if (! (this instanceof pccm) ) {return new pccm(options);}

    /**
     * {
     *      app : APP OBJECT
     *      status : STOP | RUNNING
     *      pid : PID,
     *      child: CHILD_PROCESS
     * }
     */
    this.appList = {};

};

/**保存进程负载情况 */
pccm.prototype.loadInfo = [];

/**
 * 通过loadInfo保存的数据计算并显示进程和系统的负载情况。
 * 这个函数只能在Master进程中调用。
 * @param {object} w 子进程发送的数据。
 */
pccm.prototype.sendLoadInfo = function () {
    var total = Object.keys(cluster.workers).length;
    if (this.loadInfo.length >= total) {
        this.loadInfo.sort((a, b) => {
            if (a.pid < b.pid) {
                return -1;
            } else if (a.pid > b.pid) {
                return 1;
            }
            return 0;
        });

        var oavg = os.loadavg();
        if (process.send && typeof process.send === 'function') {
            process.send({
                cpuavg : oavg,
                loadinfo : this.loadInfo
            });
        }
        this.loadInfo = [w];
    } else {
        this.loadInfo.push(w);
    }
};

/**
 * Master进程调用的函数，用于监听消息事件。
 */
pccm.prototype.servMessage = function (rundata) {
    var the = this;

    cluster.on('message', (worker, msg, handle) => {
        try {
            switch(msg.type) {
                case 'load':
                    the.sendLoadInfo(msg); break;
                case 'running':
                    rundata.rcount -= rundata.rcone;
                    if (rundata.rcount < 0) {
                        rundata.rcount = 0;
                    }
                    break;
                default:;
            }
        } catch (err) {

        }
    });
};

/**
 * 在处理子进程异常退出的时候，其方案十分简单，当子进程启动后则在指定时间后向父进程发送消息，
 * 如果在此未发送，则会记录程序异常退出的次数，如果发送则记录次数会清零。
 * 如此，则在连续异常时，会在超过指定次数时不再重新启动。
 */

/**
 * 此函数默认会根据CPU核数创建对应的子进程处理请求。
 * @param {object} aj 应用的JSON配置对象。
 * - app
 * - name
 * - workerNumber
 * - pidFile
 * - args
*/
pccm.prototype.serv = function (aj) {

    let iaj = {
        app : '',
        name : '',
        num : 0,
        pidFile : '',
        args : [],
        restartCount: 15,
    };

    for (let k in aj) {
        if (k == 'app') {
            try {
                fs.accessSync(aj.app, fs.constants.F_OK);
                iaj.app = aj.app;
            } catch (err) {
                console.log(err.message);
                return ;
            }
        } else if (k == 'num') {
            if (typeof aj.num === 'number' && parseInt(aj.num) > 0) {
                iaj.num = aj.num;
            }
        } else if (k == 'args') {
            iaj.args = aj.args;
        } else if (k == 'name') {
            iaj.name = aj.name;
        } else if (k == 'pidFile') {
            iaj.pidFile = aj.pidFile;
        } else if (k == 'restartCount') {
            iaj.restartCount = aj[k];
        }
    }

    iaj.args.shift(`--app-name=${iaj.name}`);

    if (cluster.isMaster) {
        cluster.setupMaster(iaj.app, iaj.args);

        let cpus = os.cpus().length;
        if (iaj.num <= 0 || iaj.num > (cpus*2+2) ) { iaj.num = cpus; }
        
        var rundata = {
            rcone : iaj.restartCount,
            rcount : 0,
            rlimit : iaj.num * iaj.restartCount
        };
        this.servMessage(rundata);

        for(var i=0; i<num; i++) { cluster.fork(); }
        if (cluster.isMaster) {
            setInterval(() => {
                var num_dis = iaj.num - Object.keys(cluster.workers).length;
                rundata.rlimit = num_dis * iaj.restartCount;
                for(var i=0; i < num_dis; i++) {
                    if (rundata.rcount >= rundata.rlimit) {
                        process.exit(0); //如果多次重启失败则退出master进程
                    }
                    cluster.fork();
                    rundata.rcount += 1;
                }
            }, 2000);
        }
    } else if (cluster.isWorker) {
        var cpuLast = {user: 0, system: 0};
        var cpuTime = {};
        setInterval(() => {
            cpuTime = process.cpuUsage(cpuLast);
            process.send({
                type : 'load',
                pid  : process.pid,
                cpu  : cpuTime,
                mem  : process.memoryUsage(),
            });
            cpuLast = process.cpuUsage();
        }, 1024);

        setTimeout(() => {
            //告知Master进程，正在运行，可清零重启次数。
            process.send({
                type : 'running'
            });
        }, 5000);
    }
};

pccm.prototype.fork1 = function (options = {}) {
    if (process.env.isFork === undefined) {
        if (options.args && options.args instanceof Array) {
            for (let i=0; i<options.args.length; i++) {
                process.argv.push(options.args[i]);
            }
        }
        let env = {
            isFork : 1
        };
        for (let k in process.env) {
            env[k] = process.env[k];
        }
        let ch = spawn(process.argv[0], process.argv.slice(1), {
            env : env,
            stdio : options.stdio || ['ignore', 1, 2, 'ipc']
        });
        return ch;
    }
    return null;
};

/**
 * 支持三种形式来添加App：
 *  1. 如果指定了参数：--app 
 *  2. 如果指定了文件：--file 或 -f 
 *  3. 如果当前目录存在文件：apps.json
 */
pccm.prototype.init = function () {
    var self = this;
    let apptmp = [];
    let appind = -1;
    for (let i=2; i < process.argv.length-1; i++) {
        switch (process.argv[i]) {
            case '--app':
                appind += 1;
                apptmp[appind] = {
                    app : process.argv[i+1],
                    args: [],
                    name : '',
                    pidFile: '',
                    num : 0
                };
                i += 1;
                break;
            case '--name':
                if (appind < 0) {
                    throw new Error('name less');
                }
                apptmp[appind].name = process.argv[i+1];
                i += 1;
                break;
            case '-n':
            case '--num':
                if (appind < 0) {
                    throw new Error('worker number less');
                }
                apptmp[appind].num = parseInt(process.argv[i+1]);
                i += 1;
                break;
            case '-f':
            case '--file':
                i += 1;
                this.loadFile(process.argv[i+1]);
                break;
            default:;
        }
    }
    for (let i=0; i<apptmp.length; i++) {
        this.addToList(apptmp[i]);
    }
    try {
        fs.accessSync('./apps.json');
        this.loadFile('./apps.json');
    } catch (err) {
        console.log(err);
    }
};

pccm.prototype.loadFile = function (f) {
    let data = fs.readFileSync(f, {encoding:'utf8'});
    let apps = JSON.parse(data);
    for (let i=0; i<apps.length; i++) {
        if (this.checkApp(apps[i])) {
            this.addToList(apps[i]);
        } else {
            console.log('ERROR:', apps[i]);
        }
    }
};

function randId () {
    var charr = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g',
        'h', 'j', 'k', 'm', 'n',
        'p', 'q', 'r', 's', 't',
        'u', 'v', 'w', 'x', 'x', 'y', 'z'
    ];
    let rid = '';
    let total = charr.length;
    for (let i=0; i<8; i++) {
        rid += charr[ parseInt(Math.random() * 10000) % total ];
    }
    return rid;
}

pccm.prototype.addToList = function (a) {
    if (a.name === undefined || a.name.length == 0) {
        a.name = randId();
    }
    if (this.appList[a.name] !== undefined) {
        throw new Error(`App<${a.name}> already here`);
    }
    this.appList[a.name] = {
        app : a,
        status : 'STOP',
        pid : 0
    };
};

pccm.prototype.checkApp = function (a) {
    if (typeof a !== 'object') {
        return false;
    }
    if (a.app === undefined 
        || typeof a.app !== 'string' 
        || a.app.trim().length == 0)
    {
        return false;
    }
    a.app = a.app.trim();
    return true;
};

/**
 * 解析命令
 */
pccm.prototype.parseIns = function (inst) {
    let iarr = inst.split(' ').filter( p => p.length > 0);
    return iarr;
};

/**
 * unix域服务，用于本地命令管理，命令格式：
 *      子命令 选项
 * 命令支持：
 *      start  stop  restart  exit  show  list
 * 命令基本格式：
 *  start [APPNAME|all]
 *  stop [APPNAME|all]
 *  restart [APPNAME|all]
 *  show [APPNAME|all]
 *  list
 *  exit
 */
pccm.prototype.dserv = function () {
    var Start = function () {

    };

    var Stop = function () {

    };

    var Restart = function () {

    };

    var Show = function () {

    };

    var List = function () {

    };

    let sockfile = '/tmp/pccm.sock';
    try {
        fs.unlinkSync(sockfile);
    } catch (err) {
        console.log(err.message);
    }
    
    var opts = {
        allowHalfOpen : true
    };
    
    var serv = net.createServer(opts,(c) => {
        var totalData = '';
        c.on('end', () => {
            c.end(totalData, {encoding:'utf8'});
        });
    
        c.on('data', (data) => {
            totalData += data.toString('utf8');
        });
    });
    
    serv.listen(sockfile, () => {
        console.log('server listening\n');
    });
};

pccm.prototype.daemon = function () {
    var self = this;

    if (process.env.isFork === undefined) {
        console.log(process.pid);
        self.init();
        let ch = '';
        for (let k in self.appList) {
            ch = self.fork1({args : [
                '--app-config=' + JSON.stringify(self.appList[k])
            ]});
            self.appList[k].pid = ch.pid;
            self.appList[k].status = 'READY';
            self.appList[k].child = ch;
            ch.on('message', (msg) => {
                switch (msg.type) {
                    case 'running':
                        self.appList[msg.appname].status = 'RNNING';
                        break;
                    case 'exit':
                        self.appList[msg.appname].status = 'STOP';
                        self.appList[msg.appname].child = null;
                        break;
                    default:;
                }
            });
        }
        ch = null;

    } else {
        let argscfg = '--app-config=';
        let a = '';
        for (let i=1; i<process.argv.length; i++) {
            if (process.argv[i].indexOf(argscfg) == 0) {
                a = JSON.parse(process.argv[i].substring(argscfg.length));
                break;
            }
        }

        process.on('exit', (code) => {
            process.send({
                type : 'exit',
                code : code,
                appname : a.name
            });
        });
        
        self.serv(a);

        //通知父进程已运行
        process.send({
            type : 'running',
            appname : a.name
        });
    }
    
};

module.exports = pccm;
