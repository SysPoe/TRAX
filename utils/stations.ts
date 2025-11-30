import { cacheLoaded, getAugmentedStops, getRawStops } from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { AugmentedStop } from "./augmentedStop.js";
import * as gtfsTypes from "qdf-gtfs";

let qr_stations: string[] = JSON.parse(
	'["place_albsta","place_aldsta","place_altsta","place_ascsta","place_aucsta","place_balsta","place_bansta","place_baysta","place_bbrsta","place_bdlsta","place_beesta","place_betsta","place_binsta","place_birsta","place_bowsta","place_brasta","place_brdsta","place_bunsta","place_bursta","place_bvlsta","place_bwrsta","place_cabstn","place_cansta","place_cassta","place_censta","place_chesta","place_clasta","place_clesta","place_cmrstn","place_coosta","place_corsta","place_cppsta","place_crnsta","place_crysta","place_daksta","place_darsta","place_dbnsta","place_deasta","place_dinsta","place_domsta","place_dupsta","place_eassta","place_ebbsta","place_edesta","place_egjsta","place_elmsta","place_enosta","place_eudsta","place_eumsta","place_exhsta","place_faista","place_fersta","place_forsta","place_frusta","place_gaista","place_gaysta","place_geesta","place_gmtsta","place_goosta","place_grasta","place_grosta","place_gymsta","place_helsta","place_hemsta","place_hensta","place_holsta","place_indsta","place_intsta","place_ipssta","place_kalsta","place_karsta","place_kepsta","place_kgtsta","place_kprsta","place_kursta","place_lansta","place_lawsta","place_linsta","place_logsta","place_lotsta","place_mahsta","place_mansta","place_mgssta","place_mhesta","place_milsta","place_mitsta","place_molsta","place_moosta","place_mudsta","place_mursta","place_myesta","place_namsta","place_narsta","place_newsta","place_nobsta","place_norsta","place_npksta","place_nrgsta","place_nudsta","place_nunsta","place_omesta","place_ormsta","place_oxfsta","place_oxlsta","place_palsta","place_parsta","place_petsta","place_pimsta","place_pomsta","place_rbnsta","place_redsta","place_ricsta","place_rivsta","place_rocsta","place_romsta","place_rossta","place_rotsta","place_runsta","place_sbasta","place_sgtsta","place_shesta","place_shnsta","place_slysta","place_snssta","place_sousta","place_spcsta","place_sprsta","place_strsta","place_sunsta","place_tarsta","place_tensta","place_thasta","place_thmsta","place_thosta","place_tomsta","place_trista","place_trvsta","place_twgsta","place_varsta","place_virsta","place_wacsta","place_walsta","place_wbysta","place_wdrsta","place_welsta","place_wilsta","place_winsta","place_wnmsta","place_wolsta","place_wulsta","place_wyhsta","place_wynsta","place_yansta","place_yeesta","place_yersta","place_zllsta"]',
);

export function getGtfsStations(): gtfsTypes.Stop[] {
	if (cacheLoaded()) return qr_stations.flatMap((stop_id) => getRawStops(stop_id)).filter((v) => v);
	return getGtfs().getStops().filter(v => qr_stations.includes(v.stop_id));
}

export function getStations(): AugmentedStop[] {
	return qr_stations.map((stop_id) => getAugmentedStops(stop_id)[0]).filter((v) => v);
}
