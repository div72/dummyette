import {Color, standardBoard, other} from "./chess.js"
import {RewindJoinStream} from "./streams.js"
import {splitBrowserStream} from "./streams-browser.js"

export let Lichess = async token =>
{
	token = String(token)
	let headers = {authorization: token}
	
	let response = await fetch("https://lichess.org/api/account", {headers})
	if (!response.ok) return
	let {id: username} = await response.json()
	
	let events = await streamURL(headers, "https://lichess.org/api/stream/event")
	if (!events) return
	
	events.last.then(() =>
	{
		console.error("The lichess event stream was broken, finalizing the process.")
		Deno.exit(-1)
	})
	
	let StockfishGame = async (level = 1, color = "random") =>
	{
		level = Number(level)
		if (Math.floor(level) !== level) return
		if (level < 1) return
		if (level > 8) return
		level = String(level)
		
		if (color !== "random")
			color = Color(color)
		if (!color) return
		
		let response = await fetch("https://lichess.org/api/challenge/ai", {method: "POST", headers, body: new URLSearchParams({level, color})})
		if (!response.ok) return
		
		let {id} = await response.json()
		return createGame(headers, id)
	}
	
	let challenges = events
		.filter(event => event.type === "challenge")
		.map(event => event.challenge)
		.filter(challenge => validateChallenge(headers, challenge))
		.map(challenge => createChallenge(headers, events, challenge))
	
	let getGameIDs = async () =>
	{
		let response = await fetch("https://lichess.org/api/account/playing", {headers})
		if (!response.ok) return
		let {nowPlaying} = await response.json()
		let ids = nowPlaying.map(({gameId}) => gameId)
		Object.freeze(ids)
		return ids
	}
	
	let getGames = async () =>
	{
		let ids = await getGameIDs()
		let promises = ids.map(id => createGame(headers, id)).filter(Boolean)
		let games = await Promise.all(promises)
		Object.freeze(games)
		return games
	}
	
	let getGame = id =>
	{
		id = String(id)
		if (!/^[a-z0-9]{8}$/i.test(id)) return
		return createGame(headers, id)
	}
	
	let declineChallenges = reason => { challenges.forEach(challenge => { challenge.decline(reason) }) }
	
	let acceptChallenges = () => challenges.map(challenge => challenge.accept(), {parallel: true}).filter(Boolean)
	
	let lichess =
	{
		StockfishGame, challenges, username, getGame,
		getGames, getGameIDs,
		declineChallenges, acceptChallenges,
	}
	Object.freeze(lichess)
	return lichess
}

let createGame = async (headers, id) =>
{
	let gameEvents = await streamURL(headers, `https://lichess.org/api/bot/game/stream/${id}`)
	if (!gameEvents) return
	
	let resign = async () =>
	{
		let response = await fetch(`https://lichess.org/api/bot/game/${id}/resign`, {method: "POST", headers})
		return response.ok
	}
	
	let n = 0
	let handle = async function * (names)
	{
		names = names.split(" ").slice(n)
		for (let name of names)
		{
			let turn = board.turn
			board = board.play(name)
			if (!board)
			{
				await resign()
				console.error(`Unexpected move in game, finalizing process: ${name}`)
				Deno.exit(-1)
			}
			
			let result = {moveName: name, move: name, board, turn, moveNumber: Math.floor(n / 2)}
			Object.freeze(result)
			n++
			yield result
		}
	}
	
	let board = standardBoard
	let status = "ongoing"
	
	let full = await gameEvents.first
	if (full.type !== "gameFull") return
	
	let {white: {id: whiteUsername}, black: {id: blackUsername}, initialFen} = full
	
	if (initialFen !== "startpos")
	{
		resign()
		return
	}
	
	let history = RewindJoinStream([full.state], gameEvents)
		.filter(event => event.type === "gameState")
		.flatMap(event => [{moves: event.moves}, {done: !["created", "started"].includes(event.status)}])
		.takeWhile(({done}) => !done)
		.map(({moves}) => moves)
		.filter(Boolean)
		.flatMap(moves => handle(moves))
	
	let moveNames = history.map(({moveName}) => moveName)
	let boards = RewindJoinStream([standardBoard], history.map(({board}) => board))
	
	await boards.slice(full.state.moves.split(" ").length - 1).first
	
	boards.last.then(board =>
	{
		if (board.moves.length === 0)
			if (board.checkmate)
				status = "checkmate"
			else
				status = "draw"
		else
			status = "aborted"
	})
	
	let play = async (...names) =>
	{
		let played = 0
		for (let name of names)
		{
			name = String(name)
			if (!/^[a-z0-9]+$/.test(name)) break
			let response = await fetch(`https://lichess.org/api/bot/game/${id}/move/${name}`, {method: "POST", headers})
			if (!response.ok) break
			played++
		}
		return played
	}
	
	let game =
	{
		id,
		moveNames, moves: moveNames,
		history, boards,
		play, resign,
		blackUsername, whiteUsername,
		get board() { return board },
		get status() { return status },
		get turn() { return board.turn },
		get finished() { return status !== "ongoing" },
		get ongoing() { return status === "ongoing" },
	}
	
	Object.freeze(game)
	return game
}

let createChallenge = async (headers, events, {id, rated, color, variant: {key: variant}, timeControl: {type: timeControl}}) =>
{
	let accept = async () =>
	{
		let gamePromise = events.find(event => event.type === "gameStart" && event.game.id === id)
		
		let response = await fetch(`https://lichess.org/api/challenge/${id}/accept`, {method: "POST", headers})
		if (!response.ok) return
		await gamePromise
		return createGame(headers, id)
	}
	
	let decline = async reason =>
	{
		if (reason === undefined) reason = "generic"
		reason = String(reason)
		let response = await fetch(`https://lichess.org/api/challenge/${id}/decline`, {method: "POST", headers, body: new URLSearchParams({reason})})
		return response.ok
	}
	
	let challenge = {id, variant, rated, timeControl, accept, decline, color}
	Object.freeze(challenge)
	return challenge
}

let validateChallenge = (headers, {id, variant}) =>
{
	if (variant.key !== "standard")
	{
		fetch(`https://lichess.org/api/challenge/${id}/decline`, {method: "POST", headers, body: new URLSearchParams({reason: "standard"})})
		return false
	}
	return true
}

let streamURL = async (headers, url) =>
{
	let response = await fetch(url, {headers})
	if (!response.ok) return
	return ndjson(response.body)
}

let decoder = new TextDecoder()
let ndjson = browserStream => splitBrowserStream(browserStream, [0x0A]).map(bytes => decoder.decode(bytes)).filter(Boolean).map(json => JSON.parse(json))
