//import Module from 'ffish-es6';
//TODO: importing from node-modules causes error while running gulp:
//'import' and 'export' may appear only with 'sourceType: module'
import Module from '../static/ffish.js';
import Sockette from 'sockette';

import { init } from 'snabbdom';
import { h } from 'snabbdom/h';
import { VNode } from 'snabbdom/vnode';
import klass from 'snabbdom/modules/class';
import attributes from 'snabbdom/modules/attributes';
import properties from 'snabbdom/modules/props';
import listeners from 'snabbdom/modules/eventlisteners';

import { Chessground } from 'chessgroundx';
import { Api } from 'chessgroundx/api';
import { key2pos, pos2key } from 'chessgroundx/util';
import { Color, Dests, Pieces, PiecesDiff, Role, Key, Pos, Piece, Variant, Notation, SetPremoveMetadata } from 'chessgroundx/types';
import { DrawShape } from 'chessgroundx/draw';

import { JSONObject } from './types';
import { _ } from './i18n';
import { Gating } from './gating';
import { Promotion } from './promotion';
import { dropIsValid, pocketView, updatePockets, Pockets } from './pocket';
import { sound } from './sound';
import { roleToSan, grand2zero, zero2grand, VARIANTS, IVariant, getPockets, sanToRole } from './chess';
import { crosstableView } from './crosstable';
import { chatMessage, chatView } from './chat';
import { createMovelistButtons, updateMovelist, selectMove, activatePlyVari } from './movelist';
import { povChances } from './winningChances';
import { copyTextToClipboard } from './clipboard';
import { analysisChart } from './chart';
import { copyBoardToPNG } from './png'; 
import { updateCount, updatePoint } from './info';
import { boardSettings } from './boardSettings';
import { variantsIni } from './variantsIni';

const patch = init([klass, attributes, properties, listeners]);

const EVAL_REGEX = new RegExp(''
  + /^info depth (\d+) seldepth \d+ multipv (\d+) /.source
  + /score (cp|mate) ([-\d]+) /.source
  + /(?:(upper|lower)bound )?nodes (\d+) nps \S+ /.source
  + /(?:hashfull \d+ )?(?:tbhits \d+ )?time (\S+) /.source
  + /pv (.+)/.source);

const maxDepth = 18;
const maxThreads = Math.max((navigator.hardwareConcurrency || 1) - 1, 1);

function download(filename, text) {
  const element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}


export default class AnalysisController {
    model;
    sock;
    chessground: Api;
    fullfen: string;
    wplayer: string;
    bplayer: string;
    base: number;
    inc: number;
    mycolor: Color;
    oppcolor: Color;
    turnColor: Color;
    gameId: string;
    variant: IVariant;
    hasPockets: boolean;
    pockets: Pockets;
    vpocket0: VNode;
    vpocket1: VNode;
    vplayer0: VNode;
    vplayer1: VNode;
    vpgn: VNode;
    vscore: VNode | HTMLElement;
    vinfo: VNode | HTMLElement;
    vpv: VNode | HTMLElement;
    vmovelist: VNode | HTMLElement;
    gameControls: VNode;
    moveControls: VNode;
    gating: Gating;
    promotion: Promotion;
    dests: Dests;
    promotions: string[];
    lastmove: Key[];
    premove: {orig: Key, dest: Key, metadata?: SetPremoveMetadata} | null;
    predrop: {role: Role, key: Key} | null;
    preaction: boolean;
    result: string;
    flip: boolean;
    spectator: boolean;
    settings: boolean;
    status: number;
    steps;
    pgn: string;
    uci_usi: string;
    ply: number;
    plyVari: number;
    players: string[];
    titles: string[];
    ratings: string[];
    clickDrop: Piece | undefined;
    clickDropEnabled: boolean;
    animation: boolean;
    showDests: boolean;
    analysisChart;
    ctableContainer: VNode | HTMLElement;
    localEngine: boolean;
    localAnalysis: boolean;
    ffish;
    ffishBoard;
    maxDepth: number;
    isAnalysisBoard: boolean;
    isEngineReady: boolean;
    notation: Notation;
    notationAsObject;
    prevPieces: Pieces;
    bigBoard: boolean;
    arrow: boolean;

    constructor(el, model) {
        this.isAnalysisBoard = model["gameId"] === "";

        const onOpen = (evt) => {
            console.log("ctrl.onOpen()", evt);
            if (this.model['embed']) {
                this.doSend({ type: "embed_user_connected", gameId: this.model["gameId"] });
            } else if (!this.isAnalysisBoard) {
                this.doSend({ type: "game_user_connected", username: this.model["username"], gameId: this.model["gameId"] });
            }
        };

        const opts = {
            maxAttempts: 10,
            onopen: e => onOpen(e),
            onmessage: e => this.onMessage(e),
            onreconnect: e => console.log('Reconnecting in round...', e),
            onmaximum: e => console.log('Stop Attempting!', e),
            onclose: e => console.log('Closed!', e),
            onerror: e => console.log('Error:', e),
            };

        const ws = (location.host.indexOf('pychess') === -1) ? 'ws://' : 'wss://';
        this.sock = new Sockette(ws + location.host + "/wsr", opts);

        // is local stockfish.wasm engine supports current variant?
        this.localEngine = false;

        // is local engine analysis enabled? (the switch)
        this.localAnalysis = false;

        // UCI isready/readyok
        this.isEngineReady = false;

        // loaded Fairy-Stockfish ffish.js wasm module
        this.ffish = null;
        this.ffishBoard = null;
        this.maxDepth = maxDepth;

        // current interactive analysis variation ply
        this.plyVari = 0;

        this.model = model;
        this.gameId = model["gameId"] as string;
        this.variant = VARIANTS[model["variant"]];
        this.fullfen = model["fen"] as string;
        this.wplayer = model["wplayer"] as string;
        this.bplayer = model["bplayer"] as string;
        this.base = model["base"] as number;
        this.inc = model["inc"] as number;
        this.status = model["status"] as number;
        this.steps = [];
        this.pgn = "";
        this.ply = 0;

        this.flip = false;
        this.settings = true;
        this.clickDropEnabled = true;
        this.animation = localStorage.animation === undefined ? true : localStorage.animation === "true";
        this.showDests = localStorage.showDests === undefined ? true : localStorage.showDests === "true";
        this.arrow = localStorage.arrow === undefined ? true : localStorage.arrow === "true";

        this.spectator = this.model["username"] !== this.wplayer && this.model["username"] !== this.bplayer;
        this.hasPockets = this.variant.pocket;
        if (this.variant.name === 'janggi') { // TODO make this more generic / customisable
            this.notation = Notation.JANGGI;
        } else {
            if (this.variant.name.endsWith("shogi") || this.variant.name === 'dobutsu') {
                this.notation = Notation.SHOGI_HODGES_NUMBER;
            } else {
                this.notation = Notation.SAN;
            }
        }
        this.bigBoard = this.variant.boardHeight >= 10;

        // orientation = this.mycolor
        if (this.spectator) {
            this.mycolor = 'white';
            this.oppcolor = 'black';
        } else {
            this.mycolor = this.model["username"] === this.wplayer ? 'white' : 'black';
            this.oppcolor = this.model["username"] === this.wplayer ? 'black' : 'white';
        }

        // players[0] is top player, players[1] is bottom player
        this.players = [
            this.mycolor === "white" ? this.bplayer : this.wplayer,
            this.mycolor === "white" ? this.wplayer : this.bplayer
        ];
        this.titles = [
            this.mycolor === "white" ? this.model['btitle'] : this.model['wtitle'],
            this.mycolor === "white" ? this.model['wtitle'] : this.model['btitle']
        ];
        this.ratings = [
            this.mycolor === "white" ? this.model['brating'] : this.model['wrating'],
            this.mycolor === "white" ? this.model['wrating'] : this.model['brating']
        ];

        this.result = "*";
        const parts = this.fullfen.split(" ");

        const fen_placement = parts[0];
        this.turnColor = parts[1] === "w" ? "white" : "black";

        this.steps.push({
            'fen': this.fullfen,
            'move': undefined,
            'check': false,
            'turnColor': this.turnColor,
            });

        this.chessground = Chessground(el, {
            fen: fen_placement,
            variant: this.variant.name as Variant,
            geometry: this.variant.geometry,
            notation: this.notation,
            orientation: this.mycolor,
            turnColor: this.turnColor,
            animation: { enabled: this.animation },
        });

        this.chessground.set({
            animation: { enabled: this.animation },
            movable: {
                free: false,
                color: this.mycolor,
                showDests: this.showDests,
                events: {
                    after: this.onUserMove,
                    afterNewPiece: this.onUserDrop,
                }
            },
            events: {
                move: this.onMove(),
                dropNewPiece: this.onDrop(),
                select: this.onSelect(),
            }
        });

        this.gating = new Gating(this);
        this.promotion = new Promotion(this);

        // initialize pockets
        if (this.hasPockets) {
            const pocket0 = document.getElementById('pocket0') as HTMLElement;
            const pocket1 = document.getElementById('pocket1') as HTMLElement;
            updatePockets(this, pocket0, pocket1);
        }

        if (!this.isAnalysisBoard && !this.model["embed"]) {
            this.ctableContainer = document.getElementById('ctable-container') as HTMLElement;
        }

        // Hide #chart div (embed view has no #chart)
        if (!this.model["embed"]) {
            const element = document.getElementById('chart') as HTMLElement;
            element.style.display = 'none';
        }


        createMovelistButtons(this);
        this.vmovelist = document.getElementById('movelist') as HTMLElement;

        if (!this.isAnalysisBoard && !this.model["embed"]) {
            patch(document.getElementById('roundchat') as HTMLElement, chatView(this, "roundchat"));
            document.documentElement.style.setProperty('--toolsHeight', '136px');
        } else {
            this.checkStatus({fen: this.fullfen});
            document.documentElement.style.setProperty('--toolsHeight', '92px');
        }

        if (!this.model["embed"]) {
            patch(document.getElementById('input') as HTMLElement, h('input#input', this.renderInput()));

            this.vscore = document.getElementById('score') as HTMLElement;
            this.vinfo = document.getElementById('info') as HTMLElement;
            this.vpv = document.getElementById('pv') as HTMLElement;
        }

        if (this.variant.materialPoint) {
            const miscW = document.getElementById('misc-infow') as HTMLElement;
            const miscB = document.getElementById('misc-infob') as HTMLElement;
            miscW.style.textAlign = 'right';
            miscB.style.textAlign = 'left';
            miscW.style.width = '100px';
            miscB.style.width = '100px';
            patch(document.getElementById('misc-info-center') as HTMLElement, h('div#misc-info-center', '-'));
            (document.getElementById('misc-info') as HTMLElement).style.justifyContent = 'space-around';
        }

        if (this.variant.counting) {
            (document.getElementById('misc-infow') as HTMLElement).style.textAlign = 'center';
            (document.getElementById('misc-infob') as HTMLElement).style.textAlign = 'center';
        }

        boardSettings.ctrl = this;
        const boardFamily = this.variant.board;
        const pieceFamily = this.variant.piece;
        boardSettings.updateBoardStyle(boardFamily);
        boardSettings.updatePieceStyle(pieceFamily);
        boardSettings.updateZoom(boardFamily);
    }

    getGround = () => this.chessground;

    private pass = () => {
        let passKey = 'z0';
        const pieces = this.chessground.state.pieces;
        const dests = this.chessground.state.movable.dests;
        for (const key in pieces) {
            if (pieces[key]!.role === 'king' && pieces[key]!.color === this.turnColor) {
                if ((key in dests!) && (dests![key].indexOf(key as Key) >= 0)) passKey = key;
            }
        }
        if (passKey !== 'z0') {
            // prevent calling pass() again by selectSquare() -> onSelect()
            this.chessground.state.movable.dests = undefined;
            this.chessground.selectSquare(passKey as Key);
            sound.moveSound(this.variant, false);
            this.sendMove(passKey, passKey, '');
        }
    }

    private renderInput = () => {
        return {
            attrs: {
                disabled: !this.localEngine,
            },
            on: {change: () => {
                this.localAnalysis = !this.localAnalysis;
                if (this.localAnalysis) {
                    this.vinfo = patch(this.vinfo, h('info#info', '-'));
                    this.engineStop();
                    this.engineGo();
                } else {
                    this.vinfo = patch(this.vinfo, h('info#info', _('in local browser')));
                    this.vpv = patch(this.vpv, h('div#pv'));
                    this.engineStop();
                }
            }}
        };
    }

    private drawAnalysisChart = (withRequest: boolean) => {
        if (withRequest) {
            if (this.model["anon"] === 'True') {
                alert(_('You need an account to do that.'));
                return;
            }
            const element = document.getElementById('request-analysis') as HTMLElement;
            if (element !== null) element.style.display = 'none';

            this.doSend({ type: "analysis", username: this.model["username"], gameId: this.gameId });
            const loaderEl = document.getElementById('loader') as HTMLElement;
            loaderEl.style.display = 'block';
        }
        const chartEl = document.getElementById('chart') as HTMLElement;
        chartEl.style.display = 'block';
        analysisChart(this);
    }

    private checkStatus = (msg) => {
        if ((msg.gameId !== this.gameId && !this.isAnalysisBoard) || this.model["embed"]) return;
        if ((msg.status >= 0) || this.isAnalysisBoard) {

            // Save finished game full pgn sent by server
            if (msg.pgn !== undefined) this.pgn = msg.pgn;
            // but on analysis page we always present pgn move list leading to current shown position!
            const pgn = (this.isAnalysisBoard) ? this.getPgn() : this.pgn;

            this.uci_usi = msg.uci_usi;

            let container = document.getElementById('copyfen') as HTMLElement;
            if (container !== null) {
                const buttons = [
                    h('a.i-pgn', { on: { click: () => download("pychess-variants_" + this.gameId, pgn) } }, [
                        h('i', {props: {title: _('Download game to PGN file')}, class: {"icon": true, "icon-download": true} }, _(' Download PGN'))]),
                    h('a.i-pgn', { on: { click: () => copyTextToClipboard(this.uci_usi) } }, [
                        h('i', {props: {title: _('Copy USI/UCI to clipboard')}, class: {"icon": true, "icon-clipboard": true} }, _(' Copy UCI/USI'))]),
                    h('a.i-pgn', { on: { click: () => copyBoardToPNG(this.fullfen) } }, [
                        h('i', {props: {title: _('Download position to PNG image file')}, class: {"icon": true, "icon-download": true} }, _(' PNG image'))]),
                    ]
                if (this.steps[0].analysis === undefined && !this.isAnalysisBoard) {
                    buttons.push(h('button#request-analysis', { on: { click: () => this.drawAnalysisChart(true) } }, [
                        h('i', {props: {title: _('Request Computer Analysis')}, class: {"icon": true, "icon-bar-chart": true} }, _(' Request Analysis'))])
                    );
                }
                patch(container, h('div', buttons));
            }

            const e = document.getElementById('fullfen') as HTMLInputElement;
            e.value = this.fullfen;

            container = document.getElementById('pgntext') as HTMLElement;
            this.vpgn = patch(container, h('textarea#pgntext', { attrs: { rows: 13, readonly: true, spellcheck: false} }, pgn));

            if (!this.isAnalysisBoard) selectMove(this, this.ply);
        }
    }

    private onMsgBoard = (msg) => {
        if (msg.gameId !== this.gameId) return;

        const pocketsChanged = this.hasPockets && (getPockets(this.fullfen) !== getPockets(msg.fen));

        // console.log("got board msg:", msg);
        this.ply = msg.ply
        this.fullfen = msg.fen;
        this.dests = msg.dests;
        // list of legal promotion moves
        this.promotions = msg.promo;

        const parts = msg.fen.split(" ");
        this.turnColor = parts[1] === "w" ? "white" : "black";

        this.result = msg.result;
        this.status = msg.status;

        if (msg.steps.length > 1) {
            this.steps = [];

            msg.steps.forEach((step, ply) => {
                if (step.analysis !== undefined) {
                    step['ceval'] = step.analysis;
                    const scoreStr = this.buildScoreStr(ply % 2 === 0 ? "w" : "b", step.analysis);
                    step['scoreStr'] = scoreStr;
                }
                this.steps.push(step);
                });
            updateMovelist(this);

            if (this.steps[0].analysis !== undefined) {
                this.vinfo = patch(this.vinfo, h('info#info', '-'));
                this.drawAnalysisChart(false);
            }
        } else {
            if (msg.ply === this.steps.length) {
                const step = {
                    'fen': msg.fen,
                    'move': msg.lastMove,
                    'check': msg.check,
                    'turnColor': this.turnColor,
                    'san': msg.steps[0].san,
                    };
                this.steps.push(step);
                updateMovelist(this);
            }
        }

        let lastMove = msg.lastMove;
        if (lastMove !== null) {
            if (this.bigBoard) {
                lastMove = grand2zero(lastMove);
            }
            // drop lastMove causing scrollbar flicker,
            // so we remove from part to avoid that
            lastMove = lastMove.indexOf('@') > -1 ? [lastMove.slice(-2)] : [lastMove.slice(0, 2), lastMove.slice(2, 4)];
        }
        // save capture state before updating chessground
        // 960 king takes rook castling is not capture
        const step = this.steps[this.steps.length - 1];
        const capture = (lastMove !== null) && ((this.chessground.state.pieces[lastMove[1]] && step.san.slice(0, 2) !== 'O-') || (step.san.slice(1, 2) === 'x'));

        if (lastMove !== null && (this.turnColor === this.mycolor || this.spectator)) {
            sound.moveSound(this.variant, capture);
        } else {
            lastMove = [];
        }
        this.checkStatus(msg);

        if (this.spectator) {
            this.chessground.set({
                fen: parts[0],
                turnColor: this.turnColor,
                check: msg.check,
                lastMove: lastMove,
            });
            if (pocketsChanged) updatePockets(this, this.vpocket0, this.vpocket1);
        }
        if (this.model["ply"]) {
            this.ply = parseInt(this.model["ply"])
            selectMove(this, this.ply);
        }
    }

    moveIndex = (ply) => {
      return Math.floor((ply - 1) / 2) + 1 + (ply % 2 === 1 ? '.' : '...');
    }

    notation2ffishjs = (n) => {
        switch (n) {
            case Notation.DEFAULT: return this.ffish.Notation.DEFAULT;
            case Notation.SAN: return this.ffish.Notation.SAN;
            case Notation.LAN: return this.ffish.Notation.LAN;
            case Notation.SHOGI_HOSKING: return this.ffish.Notation.SHOGI_HOSKING;
            case Notation.SHOGI_HODGES: return this.ffish.Notation.SHOGI_HODGES;
            case Notation.SHOGI_HODGES_NUMBER: return this.ffish.Notation.SHOGI_HODGES_NUMBER;
            case Notation.JANGGI: return this.ffish.Notation.JANGGI;
            case Notation.XIANGQI_WXF: return this.ffish.Notation.XIANGQI_WXF;
            default: return this.ffish.Notation.DEFAULT;
        }
    }

    onFSFline = (line) => {
        //console.log(line);

        if (line.includes('readyok')) this.isEngineReady = true;

        if (!this.localEngine) {
            if (line.includes('UCI_Variant')) {
                new (Module as any)().then(loadedModule => {
                    this.ffish = loadedModule;

                    if (this.ffish !== null) {
                        this.ffish.loadVariantConfig(variantsIni);
                        this.notationAsObject = this.notation2ffishjs(this.notation);
                        const availableVariants = this.ffish.variants();
                        //console.log('Available variants:', availableVariants);
                        if (this.model.variant === 'chess' || availableVariants.includes(this.model.variant)) {
                            this.ffishBoard = new this.ffish.Board(this.variant.name, this.fullfen, this.model.chess960 === 'True');
                            this.dests = this.getDests();
                            this.chessground.set({ movable: { color: this.turnColor, dests: this.dests } });
                        } else {
                            console.log("Selected variant is not supported by ffish.js");
                        }
                    }
                });

                // TODO: enable S-chess960 when stockfish.wasm catches upstream Fairy-Stockfish
                if ((this.model.variant === 'chess' || line.includes(this.model.variant)) &&
                    !(this.model.variant === 'seirawan' && this.model.chess960 === 'True')) {
                    this.localEngine = true;
                    patch(document.getElementById('input') as HTMLElement, h('input#input', {attrs: {disabled: false}}));
                } else {
                    const v = this.model.variant + ((this.model.chess960 === 'True') ? '960' : '');
                    const title = _("Selected variant %1 is not supported by stockfish.wasm", v);
                    patch(document.getElementById('slider') as HTMLElement, h('span.sw-slider', {attrs: {title: title}}));
                }
            }
        }

        if (!this.localAnalysis || !this.isEngineReady) return;

        const matches = line.match(EVAL_REGEX);
        if (!matches) {
            if (line.includes('mate 0')) {
                const msg = {type: 'local-analysis', ply: this.ply, color: this.turnColor.slice(0, 1), ceval: {d: 0, s: {mate: 0}}};
                this.onMsgAnalysis(msg);
            }
            return;
        }

        const depth = parseInt(matches[1]),
            multiPv = parseInt(matches[2]),
            isMate = matches[3] === 'mate',
            povEv = parseInt(matches[4]),
            evalType = matches[5],
            nodes = parseInt(matches[6]),
            elapsedMs: number = parseInt(matches[7]),
            moves = matches[8];
        //console.log("---", depth, multiPv, isMate, povEv, evalType, nodes, elapsedMs, moves);

        // Sometimes we get #0. Let's just skip it.
        if (isMate && !povEv) return;

        // For now, ignore most upperbound/lowerbound messages.
        // The exception is for multiPV, sometimes non-primary PVs
        // only have an upperbound.
        // See: https://github.com/ddugovic/Stockfish/issues/228
        if (evalType && multiPv === 1) return;

        let score;
        if (isMate) {
            score = {mate: povEv};
        } else {
            score = {cp: povEv};
        }
        const knps = nodes / elapsedMs;
        const sanMoves = this.ffishBoard.variationSan(moves, this.notationAsObject);
        const msg = {type: 'local-analysis', ply: this.ply, color: this.turnColor.slice(0, 1), ceval: {d: depth, m: moves, p: sanMoves, s: score, k: knps}};
        this.onMsgAnalysis(msg);
    };

    onMoreDepth = () => {
        this.maxDepth = 99;
        this.engineStop();
        this.engineGo();
    }

    // Updates PV, score, gauge and the best move arrow
    drawEval = (ceval, scoreStr, turnColor) => {
        let shapes0: DrawShape[] = [];
        this.chessground.setAutoShapes(shapes0);

        const gaugeEl = document.getElementById('gauge') as HTMLElement;
        if (gaugeEl) {
            const blackEl = gaugeEl.querySelector('div.black') as HTMLElement | undefined;
            if (blackEl && ceval !== undefined) {
                const score = ceval['s'];
                // TODO set gauge colour according to the variant's piece colour
                const color = (this.variant.firstColor === "Black") ? turnColor === 'black' ? 'white' : 'black' : turnColor;
                if (score !== undefined) {
                    const ev = povChances(color, score);
                    blackEl.style.height = String(100 - (ev + 1) * 50) + '%';
                }
                else {
                    blackEl.style.height = '50%';
                }
            }
        }

        if (ceval?.p !== undefined) {
            let pv_move = ceval["m"].split(" ")[0];
            if (this.bigBoard) pv_move = grand2zero(pv_move);
            console.log("ARROW", this.arrow);
            if (this.arrow) {
                const atPos = pv_move.indexOf('@');
                if (atPos > -1) {
                    const d = pv_move.slice(atPos + 1, atPos + 3);
                    let color = turnColor;
                    if (this.variant.sideDetermination === "direction")
                        if (this.flip !== (this.mycolor === "black"))
                            color = (color === 'white') ? 'black' : 'white';
                    shapes0 = [{
                        orig: d,
                        brush: 'paleGreen',
                        piece: {
                            color: color,
                            role: sanToRole[pv_move.slice(0, atPos)]
                        }},
                        { orig: d, brush: 'paleGreen'}
                    ];
                } else {
                    const o = pv_move.slice(0, 2);
                    const d = pv_move.slice(2, 4);
                    shapes0 = [{ orig: o, dest: d, brush: 'paleGreen', piece: undefined },];
                }
            }
            this.vscore = patch(this.vscore, h('score#score', scoreStr));
            const info = [h('span', _('Depth') + ' ' + String(ceval.d) + '/' + this.maxDepth)];
            if (ceval.k) {
                if (ceval.d === this.maxDepth && this.maxDepth !== 99) {
                    info.push(
                        h('a.icon.icon-plus-square', {
                            props: {type: "button", title: _("Go deeper")},
                            on: { click: () => this.onMoreDepth() }
                        })
                    );
                } else if (ceval.d !== 99) {
                    info.push(h('span', ', ' + Math.round(ceval.k) + ' knodes/s'));
                }
            }
            this.vinfo = patch(this.vinfo, h('info#info', info));
            let pvSan = ceval.p;
            if (this.ffishBoard !== null) {
                try {
                    pvSan = this.ffishBoard.variationSan(ceval.p, this.notationAsObject);
                    if (pvSan === '') pvSan = ceval.p;
                } catch (error) {
                    pvSan = ceval.p
                }
            }
            this.vpv = patch(this.vpv, h('div#pv', [h('pvline', ceval.p !== undefined ? pvSan : ceval.m)]));
        } else {
            this.vscore = patch(this.vscore, h('score#score', ''));
            this.vinfo = patch(this.vinfo, h('info#info', _('in local browser')));
            this.vpv = patch(this.vpv, h('div#pv'));
        }

        console.log(shapes0);
        this.chessground.set({
            drawable: {autoShapes: shapes0},
        });
    }

    // Updates chart and score in movelist
    drawServerEval = (ply, scoreStr) => {
        if (ply > 0) {
            const evalEl = document.getElementById('ply' + String(ply)) as HTMLElement;
            patch(evalEl, h('eval#ply' + String(ply), scoreStr));
        }

        analysisChart(this);
        const hc = this.analysisChart;
        if (hc !== undefined) {
            const hcPt = hc.series[0].data[ply];
            if (hcPt !== undefined) hcPt.select();
        }
    }

    engineStop = () => {
        this.isEngineReady = false;
        window.fsf.postMessage('stop');
        window.fsf.postMessage('isready');
    }

    engineGo = () => {
        if (this.model.chess960 === 'True') {
            window.fsf.postMessage('setoption name UCI_Chess960 value true');
        }
        if (this.model.variant !== 'chess') {
            window.fsf.postMessage('setoption name UCI_Variant value ' + this.model.variant);
        }
        //console.log('setoption name Threads value ' + maxThreads);
        window.fsf.postMessage('setoption name Threads value ' + maxThreads);

        //console.log('position fen ', this.fullfen);
        window.fsf.postMessage('position fen ' + this.fullfen);

        if (this.maxDepth >= 99) {
            window.fsf.postMessage('go depth 99');
        } else {
            window.fsf.postMessage('go movetime 90000 depth ' + this.maxDepth);
        }
    }

    getDests = () => {
        const legalMoves = this.ffishBoard.legalMoves().split(" ");
        // console.log(legalMoves);
        const dests: Dests = {};
        this.promotions = [];
        legalMoves.forEach((move) => {
            if (this.bigBoard) move = grand2zero(move);
            const source = move.slice(0, 2);
            const dest = move.slice(2, 4);
            if (source in dests) {
                dests[source].push(dest);
            } else {
                dests[source] = [dest];
            }

            const tail = move.slice(-1);
            if (tail > '9' || tail === '+') {
                if (!(this.variant.gate && (move.slice(1, 2) === '1' || move.slice(1, 2) === '8'))) {
                    this.promotions.push(move);
                }
            }
            if (this.variant.promotion === 'kyoto' && move.slice(0, 1) === '+') {
                this.promotions.push(move);
            }
        });
        this.chessground.set({ movable: { dests: dests }});
        return dests;
    }

    // When we are moving inside a variation move list
    // then plyVari > 0 and ply is the index inside vari movelist
    goPly = (ply, plyVari = 0) => {
        if (this.localAnalysis) {
            this.engineStop();
            // Go back to the main line
            if (plyVari === 0) {
                const container = document.getElementById('vari') as HTMLElement;
                patch(container, h('div#vari', ''));
            }
        }

        const step = (plyVari > 0) ? this.steps[plyVari]['vari'][ply] : this.steps[ply];
        let move = step.move;
        let capture = false;
        if (move !== undefined) {
            if (this.bigBoard) move = grand2zero(move);
            move = move.indexOf('@') > -1 ? [move.slice(-2)] : [move.slice(0, 2), move.slice(2, 4)];
            // 960 king takes rook castling is not capture
            capture = (this.chessground.state.pieces[move[move.length - 1]] !== undefined && step.san.slice(0, 2) !== 'O-') || (step.san.slice(1, 2) === 'x');
        }

        this.chessground.set({
            fen: step.fen,
            turnColor: step.turnColor,
            movable: {
                color: step.turnColor,
                dests: this.dests,
                },
            check: step.check,
            lastMove: move,
        });

        this.fullfen = step.fen;

        updatePockets(this, this.vpocket0, this.vpocket1);

        if (this.variant.counting) {
            updateCount(step.fen, document.getElementById('misc-infow') as HTMLElement, document.getElementById('misc-infob') as HTMLElement);
        }

        if (this.variant.materialPoint) {
            updatePoint(step.fen, document.getElementById('misc-infow') as HTMLElement, document.getElementById('misc-infob') as HTMLElement);
        }

        if (ply === this.ply + 1) {
            sound.moveSound(this.variant, capture);
        }

        // Go back to the main line
        if (plyVari === 0) {
            this.ply = ply
        }
        this.turnColor = step.turnColor;

        if (this.plyVari > 0 && plyVari === 0) {
            this.steps[this.plyVari]['vari'] = undefined;
            this.plyVari = 0;
            updateMovelist(this);
        }

        if (this.model["embed"]) return;

        if (this.ffishBoard !== null) {
            this.ffishBoard.setFen(this.fullfen);
            this.dests = this.getDests();
        }

        this.drawEval(step.ceval, step.scoreStr, step.turnColor);
        this.drawServerEval(ply, step.scoreStr);

        // TODO: multi PV
        this.maxDepth = maxDepth;
        if (this.localAnalysis) this.engineGo();

        const e = document.getElementById('fullfen') as HTMLInputElement;
        e.value = this.fullfen;

        if (this.isAnalysisBoard) {
            const idxInVari = (plyVari > 0) ? ply : 0;
            this.vpgn = patch(this.vpgn, h('textarea#pgntext', { attrs: { rows: 13, readonly: true, spellcheck: false} }, this.getPgn(idxInVari)));
        } else {
            const hist = this.model["home"] + '/' + this.gameId + '?ply=' + ply.toString();
            window.history.replaceState({}, this.model['title'], hist);
        }
    }

    private doSend = (message: JSONObject) => {
        // console.log("---> doSend():", message);
        this.sock.send(JSON.stringify(message));
    }

    private onMove = () => {
        return (orig, dest, capturedPiece) => {
            console.log("   ground.onMove()", orig, dest, capturedPiece);
            sound.moveSound(this.variant, capturedPiece);
        }
    }

    private onDrop = () => {
        return (piece, dest) => {
            // console.log("ground.onDrop()", piece, dest);
            if (dest != 'z0' && piece.role && dropIsValid(this.dests, piece.role, dest)) {
                sound.moveSound(this.variant, false);
            } else if (this.clickDropEnabled) {
                this.clickDrop = piece;
            }
        }
    }

    private getPgn = (idxInVari  = 0) => {
        const moves : string[] = [];
        for (let ply = 1; ply <= this.ply; ply++) {
            const moveCounter = (ply % 2 !== 0) ? (ply + 1) / 2 + '.' : '';
            if (this.steps[ply]['vari'] !== undefined && this.plyVari > 0) {
                const variMoves = this.steps[ply]['vari'];
                for (let idx = 0; idx <= idxInVari; idx++) {
                    moves.push(moveCounter + variMoves[idx]['sanSAN']);
                }
                break;
            }
            moves.push(moveCounter + this.steps[ply]['sanSAN']);
        }
        return moves.join(' ');
    }

    sendMove = (orig, dest, promo) => {
        const uci_move = orig + dest + promo;
        const move = (this.bigBoard) ? zero2grand(uci_move) : uci_move;
        const san = this.ffishBoard.sanMove(move, this.notationAsObject);
        const sanSAN = this.ffishBoard.sanMove(move);
        // console.log('sendMove()', move, san);
        // Instead of sending moves to the server we can get new FEN and dests from ffishjs
        this.ffishBoard.push(move);
        this.dests = this.getDests();

        // We can't use ffishBoard.gamePly() to determine newply because it returns +1 more
        // when new this.ffish.Board() initial FEN moving color was "b"
        const moves = this.ffishBoard.moveStack().split(' ');
        const newPly = moves.length;

        const msg = {
            gameId: this.gameId,
            fen: this.ffishBoard.fen(),
            ply: newPly,
            lastMove: move,
            dests: this.dests,
            promo: this.promotions,
            bikjang: this.ffishBoard.isBikjang(),
            check: this.ffishBoard.isCheck(),
        }
        this.onMsgAnalysisBoard(msg);

        const step = {
            'fen': msg.fen,
            'move': msg.lastMove,
            'check': msg.check,
            'turnColor': this.turnColor,
            'san': san,
            'sanSAN': sanSAN,
            };

        // New main line move
        if (this.ffishBoard.gamePly() === this.steps.length && this.plyVari === 0) {
            this.steps.push(step);
            this.ply = this.ffishBoard.gamePly()
            updateMovelist(this);

            this.checkStatus(msg);
        // variation move
        } else {
            // new variation starts
            if (newPly === 1) {
                if (msg.lastMove === this.steps[this.ply].move) {
                    // existing main line played
                    selectMove(this, this.ply);
                    return;
                }
                if (this.steps[this.plyVari]['vari'] === undefined || msg.ply === this.steps[this.plyVari]['vari'].length) {
                    // continuing the variation
                    this.plyVari = this.ffishBoard.gamePly();
                    this.steps[this.plyVari]['vari'] = [];
                } else {
                    // variation in the variation: drop old moves
                    this.steps[this.plyVari]['vari'] = this.steps[this.plyVari]['vari'].slice(0, this.ffishBoard.gamePly() - this.plyVari);    
                }
            }
            this.steps[this.plyVari]['vari'].push(step);

            const full = true;
            const activate = false;
            updateMovelist(this, full, activate);
            activatePlyVari(this.plyVari + this.steps[this.plyVari]['vari'].length - 1);
        }

        const e = document.getElementById('fullfen') as HTMLInputElement;
        e.value = this.fullfen;

        if (this.isAnalysisBoard) {
            const idxInVari = (this.plyVari > 0) ? this.steps[this.plyVari]['vari'].length - 1 : 0;
            this.vpgn = patch(this.vpgn, h('textarea#pgntext', { attrs: { rows: 13, readonly: true, spellcheck: false} }, this.getPgn(idxInVari)));
        }
        // TODO: But sending moves to the server will be useful to implement shared live analysis!
        // this.doSend({ type: "analysis_move", gameId: this.gameId, move: move, fen: this.fullfen, ply: this.ply + 1 });
    }

    private onMsgAnalysisBoard = (msg) => {
        // console.log("got analysis_board msg:", msg);
        if (msg.gameId !== this.gameId) return;
        if (this.localAnalysis) this.engineStop();

        const pocketsChanged = this.hasPockets && (getPockets(this.fullfen) !== getPockets(msg.fen));

        this.fullfen = msg.fen;
        this.dests = msg.dests;
        // list of legal promotion moves
        this.promotions = msg.promo;
        this.ply = msg.ply

        const parts = msg.fen.split(" ");
        this.turnColor = parts[1] === "w" ? "white" : "black";
        let lastMove = msg.lastMove;
        if (lastMove !== null) {
            if (this.bigBoard) {
                lastMove = grand2zero(lastMove);
            }
            // drop lastMove causing scrollbar flicker,
            // so we remove from part to avoid that
            lastMove = lastMove.indexOf('@') > -1 ? [lastMove.slice(-2)] : [lastMove.slice(0, 2), lastMove.slice(2, 4)];
        }

        this.chessground.set({
            fen: this.fullfen,
            turnColor: this.turnColor,
            lastMove: lastMove,
            check: msg.check,
            movable: {
                color: this.turnColor,
                dests: this.dests,
            },
        });

        if (pocketsChanged) updatePockets(this, this.vpocket0, this.vpocket1);

        if (this.localAnalysis) this.engineGo();
    }

    private onUserMove = (orig, dest, meta) => {
        this.preaction = meta.premove === true;
        // chessground doesn't knows about ep, so we have to remove ep captured pawn
        const pieces = this.chessground.state.pieces;
        const geom = this.chessground.state.geometry;
        // console.log("ground.onUserMove()", orig, dest, meta);
        let moved = pieces[dest];
        // Fix king to rook 960 castling case
        if (moved === undefined) moved = {role: 'king', color: this.mycolor} as Piece;
        const firstRankIs0 = this.chessground.state.dimensions.height === 10;
        if (meta.captured === undefined && moved !== undefined && moved.role === "pawn" && orig[0] != dest[0] && this.variant.enPassant) {
            const pos = key2pos(dest, firstRankIs0),
            pawnPos: Pos = [pos[0], pos[1] + (this.mycolor === 'white' ? -1 : 1)];
            const diff: PiecesDiff = {};
            diff[pos2key(pawnPos, geom)] = undefined;
            this.chessground.setPieces(diff);
            meta.captured = {role: "pawn"};
        }
        // increase pocket count
        if (this.variant.drop && meta.captured) {
            let role = meta.captured.role
            if (meta.captured.promoted)
                role = (this.variant.promotion === 'shogi' || this.variant.promotion === 'kyoto') ? meta.captured.role.slice(1) as Role : "pawn";

            let position = (this.turnColor === this.mycolor) ? "bottom": "top";
            if (this.flip) position = (position === "top") ? "bottom" : "top";
            if (position === "top") {
                this.pockets[0][role]++;
                this.vpocket0 = patch(this.vpocket0, pocketView(this, this.turnColor, "top"));
            } else {
                this.pockets[1][role]++;
                this.vpocket1 = patch(this.vpocket1, pocketView(this, this.turnColor, "bottom"));
            }
        }

        //  gating elephant/hawk
        if (this.variant.gate) {
            if (!this.promotion.start(moved.role, orig, dest) && !this.gating.start(this.fullfen, orig, dest)) this.sendMove(orig, dest, '');
        } else {
            if (!this.promotion.start(moved.role, orig, dest)) this.sendMove(orig, dest, '');
        this.preaction = false;
        }
    }

    private onUserDrop = (role, dest, meta) => {
        this.preaction = meta.predrop === true;
        // console.log("ground.onUserDrop()", role, dest, meta);
        // decrease pocket count
        if (dropIsValid(this.dests, role, dest)) {
            let position = (this.turnColor === this.mycolor) ? "bottom": "top";
            if (this.flip) position = (position === "top") ? "bottom" : "top";
            if (position === "top") {
                this.pockets[0][role]--;
                this.vpocket0 = patch(this.vpocket0, pocketView(this, this.turnColor, "top"));
            } else {
                this.pockets[1][role]--;
                this.vpocket1 = patch(this.vpocket1, pocketView(this, this.turnColor, "bottom"));
            }
            if (this.variant.promotion === 'kyoto') {
                if (!this.promotion.start(role, 'z0', dest)) this.sendMove(roleToSan[role] + "@", dest, '');
            } else {
                this.sendMove(roleToSan[role] + "@", dest, '')
            }
            // console.log("sent move", move);
        } else {
            // console.log("!!! invalid move !!!", role, dest);
            // restore board
            this.clickDrop = undefined;
            this.chessground.set({
                fen: this.fullfen,
                lastMove: this.lastmove,
                turnColor: this.mycolor,
                animation: { enabled: this.animation },
                movable: {
                    dests: this.dests,
                    showDests: this.showDests,
                    },
                }
            );
        }
        this.preaction = false;
    }

    private onSelect = () => {
        return (key) => {
            if (this.chessground.state.movable.dests === undefined) return;

            // If drop selection was set dropDests we have to restore dests here
            if (key != 'z0' && 'z0' in this.chessground.state.movable.dests) {
                if (this.clickDropEnabled && this.clickDrop !== undefined && dropIsValid(this.dests, this.clickDrop.role, key)) {
                    this.chessground.newPiece(this.clickDrop, key);
                    this.onUserDrop(this.clickDrop.role, key, {predrop: this.predrop});
                }
                this.clickDrop = undefined;
                //cancelDropMode(this.chessground.state);
                this.chessground.set({ movable: { dests: this.dests }});
            }

            // Save state.pieces to help recognise 960 castling (king takes rook) moves
            // Shouldn't this be implemented in chessground instead?
            if (this.model.chess960 === 'True' && this.variant.gate) {
                this.prevPieces = Object.assign({}, this.chessground.state.pieces);
            }

            // Janggi pass and Sittuyin in place promotion on Ctrl+click
            if (this.chessground.state.stats.ctrlKey && 
                (key in this.chessground.state.movable.dests) &&
                (this.chessground.state.movable.dests[key].indexOf(key) >= 0)
                ) {
                const piece = this.chessground.state.pieces[key];
                if (this.variant.name === 'sittuyin') { // TODO make this more generic
                    // console.log("Ctrl in place promotion", key);
                    const pieces = {};
                    pieces[key] = {
                        color: piece!.color,
                        role: 'ferz',
                        promoted: true
                    };
                    this.chessground.setPieces(pieces);
                    this.sendMove(key, key, 'f');
                } else if (this.variant.pass && piece!.role === 'king') {
                    this.pass();
                }
            }
        }
    }

    private buildScoreStr = (color, analysis) => {
        const score = analysis['s'];
        let scoreStr = '';
        let ceval = '';
        if (score['mate'] !== undefined) {
            ceval = score['mate']
            const sign = ((color === 'b' && Number(ceval) > 0) || (color === 'w' && Number(ceval) < 0)) ? '-': '';
            scoreStr = '#' + sign + Math.abs(Number(ceval));
        } else {
            ceval = score['cp']
            let nscore = Number(ceval) / 100.0;
            if (color === 'b') nscore = -nscore;
            scoreStr = nscore.toFixed(1);
        }
        return scoreStr;
    }

    private onMsgAnalysis = (msg) => {
        // console.log(msg);
        if (msg['ceval']['s'] === undefined) return;

        const scoreStr = this.buildScoreStr(msg.color, msg.ceval);

        // Server side analysis message
        if (msg.type === 'analysis') {
            this.steps[msg.ply]['ceval'] = msg.ceval;
            this.steps[msg.ply]['scoreStr'] = scoreStr;

            if (this.steps.every((step) => {return step.scoreStr !== undefined;})) {
                const element = document.getElementById('loader-wrapper') as HTMLElement;
                element.style.display = 'none';
            }
            this.drawServerEval(msg.ply, scoreStr);
        } else {
            const turnColor = msg.color === 'w' ? 'white' : 'black';
            this.drawEval(msg.ceval, scoreStr, turnColor);
        }
    }

    // User running a fishnet worker asked new server side analysis with chat message: !analysis
    private onMsgRequestAnalysis = () => {
        this.steps.forEach((step) => {
            step.analysis = undefined;
            step.ceval = undefined;
            step.score = undefined;
        });
        this.drawAnalysisChart(true);
    }

    private onMsgUserConnected = (msg) => {
        this.model["username"] = msg["username"];
        // we want to know lastMove and check status
        this.doSend({ type: "board", gameId: this.gameId });
    }

    private onMsgSpectators = (msg) => {
        const container = document.getElementById('spectators') as HTMLElement;
        patch(container, h('under-left#spectators', _('Spectators: ') + msg.spectators));
    }

    private onMsgChat = (msg) => {
        if ((this.spectator && msg.room === 'spectator') || (!this.spectator && msg.room !== 'spectator') || msg.user.length === 0) {
            chatMessage(msg.user, msg.message, "roundchat");
        }
    }

    private onMsgFullChat = (msg) => {
        // To prevent multiplication of messages we have to remove old messages div first
        patch(document.getElementById('messages') as HTMLElement, h('div#messages-clear'));
        // then create a new one
        patch(document.getElementById('messages-clear') as HTMLElement, h('div#messages'));
        msg.lines.forEach((line) => {
            if ((this.spectator && line.room === 'spectator') || (!this.spectator && line.room !== 'spectator') || line.user.length === 0) {
                chatMessage(line.user, line.message, "roundchat");
            }
        });
    }

    private onMsgGameNotFound = (msg) => {
        alert(_("Requested game %1 not found!", msg['gameId']));
        window.location.assign(this.model["home"]);
    }

    private onMsgShutdown = (msg) => {
        alert(msg.message);
    }

    private onMsgCtable = (ct, gameId) => {
        if (ct !== "") {
            this.ctableContainer = patch(this.ctableContainer, h('div#ctable-container'));
            this.ctableContainer = patch(this.ctableContainer, crosstableView(ct, gameId));
        }
    }

    private onMessage = (evt) => {
        // console.log("<+++ onMessage():", evt.data);
        const msg = JSON.parse(evt.data);
        switch (msg.type) {
            case "board":
                this.onMsgBoard(msg);
                break;
            case "analysis_board":
                this.onMsgAnalysisBoard(msg);
                break
            case "crosstable":
                this.onMsgCtable(msg.ct, this.gameId);
                break
            case "analysis":
                this.onMsgAnalysis(msg);
                break;
            case "embed_user_connected":
            case "game_user_connected":
                this.onMsgUserConnected(msg);
                break;
            case "spectators":
                this.onMsgSpectators(msg);
                break
            case "roundchat":
                this.onMsgChat(msg);
                break;
            case "fullchat":
                this.onMsgFullChat(msg);
                break;
            case "game_not_found":
                this.onMsgGameNotFound(msg);
                break
            case "shutdown":
                this.onMsgShutdown(msg);
                break;
            case "logout":
                this.doSend({type: "logout"});
                break;
            case "request_analysis":
                this.onMsgRequestAnalysis()
                break;
        }
    }
}
